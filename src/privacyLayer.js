/**
 * Privacy layer for patient clinical data — BioMint data exchange.
 *
 * Responsibilities:
 *   1. Consent token issuance — cryptographically bind patient identity to allowed data uses
 *   2. PII scrubbing — strip all identifying fields before tokenization
 *   3. ZK-friendly commitments — hash commitments for selective disclosure
 *   4. Consent verification — check a given use is covered by the token
 *
 * Design invariant: this module never logs or persists raw patient identifiers.
 * Patient nonces stay on the patient's device; only HMAC-derived pseudonyms
 * and content hashes travel to the market layer.
 */

import crypto from "node:crypto";

// ── Allowed data-use constants ───────────────────────────────────────────────

export const AllowedUse = Object.freeze({
  DIABETES_RESEARCH:  "DIABETES_RESEARCH",
  DRUG_DEVELOPMENT:   "DRUG_DEVELOPMENT",
  GENOME_RESEARCH:    "GENOME_RESEARCH",
  AI_TRAINING:        "AI_TRAINING",
  AGGREGATED_STATS:   "AGGREGATED_STATS",
});

// In production this secret lives in a hardware-backed key store.
const CONSENT_SIGNING_SECRET =
  process.env.CONSENT_SIGNING_SECRET ?? "biomint-consent-hmac-v1-demo";

// ── Consent token lifecycle ──────────────────────────────────────────────────

/**
 * Issue a signed consent token for a patient.
 *
 * The patientNonce is a random value generated and held by the patient device
 * (e.g., Dexcom app).  It is NEVER stored server-side; it is only passed in
 * transiently to produce and later verify the HMAC.
 *
 * @param {string}   patientNonce   Random nonce from the patient device
 * @param {string[]} allowedUses    Array of AllowedUse constants the patient approves
 * @param {number}   ttlDays        Consent validity period in days (default 365)
 * @returns {object} Signed consent record — safe to store, contains no PII
 */
export function generateConsentToken(patientNonce, allowedUses, ttlDays = 365) {
  if (!patientNonce || typeof patientNonce !== "string" || patientNonce.length < 16) {
    throw new Error("patientNonce must be a string of ≥16 characters");
  }
  if (!Array.isArray(allowedUses) || allowedUses.length === 0) {
    throw new Error("allowedUses must be a non-empty array");
  }

  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  const payload = { allowedUses, expiresAt, schemaVersion: 1 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const sig = crypto
    .createHmac("sha256", CONSENT_SIGNING_SECRET)
    .update(patientNonce + payloadB64)
    .digest("base64url");

  return {
    token: `${payloadB64}.${sig}`,
    allowedUses,
    expiresAt,
    issuedAt: new Date().toISOString(),
  };
}

/**
 * Verify that a consent token covers a specific use.
 *
 * @param {string} token          Token string from generateConsentToken
 * @param {string} requestedUse   AllowedUse constant
 * @param {string} patientNonce   Nonce used during token issuance (verifies HMAC)
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyConsent(token, requestedUse, patientNonce) {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return { valid: false, reason: "Malformed token — missing signature" };

    const payloadB64 = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    // Constant-time HMAC comparison to prevent timing attacks
    const expectedSig = crypto
      .createHmac("sha256", CONSENT_SIGNING_SECRET)
      .update(patientNonce + payloadB64)
      .digest("base64url");

    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, reason: "Invalid consent signature" };
    }

    if (new Date(payload.expiresAt) < new Date()) {
      return { valid: false, reason: "Consent token expired" };
    }

    if (!payload.allowedUses.includes(requestedUse)) {
      return { valid: false, reason: `Use '${requestedUse}' not covered by consent` };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: "Malformed consent token" };
  }
}

// ── PII scrubbing ────────────────────────────────────────────────────────────

const PII_KEYS = new Set([
  "patientName", "firstName", "lastName", "fullName", "name",
  "dob", "dateOfBirth", "birthDate",
  "deviceSerial", "serialNumber", "deviceId",
  "accountId", "userId", "username", "email",
  "phone", "phoneNumber", "address", "zipCode", "postalCode",
  "ssn", "mrn", "npi", "insuranceId",
]);

/**
 * Scrub PII from a raw clinical dataset.
 *
 * Timestamps are shifted by a deterministic per-patient random offset (±12 h)
 * derived from the patient nonce, so temporal patterns are preserved but
 * absolute time cannot be correlated to calendar events.
 *
 * @param {any}    rawDataset
 * @param {string} patientNonce
 * @returns Anonymized dataset (deep clone — original untouched)
 */
export function anonymize(rawDataset, patientNonce) {
  // Deterministic offset in ms: ±12 h, derived from nonce
  const offsetMs =
    (parseInt(
      crypto.createHmac("sha256", "biomint-time-offset-v1")
        .update(patientNonce)
        .digest("hex")
        .slice(0, 8),
      16
    ) % 43_200) * 1_000;

  function scrub(obj) {
    if (Array.isArray(obj)) return obj.map(scrub);
    if (obj && typeof obj === "object") {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        if (PII_KEYS.has(k)) continue;                           // drop PII
        if (k === "ts" || k === "timestamp" || k === "time") {
          result[k] = typeof v === "number" ? v + offsetMs : v;  // shift time
        } else {
          result[k] = scrub(v);
        }
      }
      return result;
    }
    return obj;
  }

  return scrub(rawDataset);
}

// ── ZK-friendly hash commitment ──────────────────────────────────────────────

/**
 * Generate a hash commitment for a dataset hash (Pedersen-style).
 *
 * The commitment is: SHA-256(dataHash || blindingFactor)
 * The blinding factor stays with the patient; the commitment goes on-chain.
 * A buyer can verify: "this commitment corresponds to this data" if given
 * the blinding factor, without the blinding factor they cannot derive the hash.
 *
 * @param {string} dataHash   Hex Merkle root from tokenizeDataset
 * @returns {{ commitment: string, blindingFactor: string }}
 */
export function generateDataCommitment(dataHash) {
  const blindingFactor = crypto.randomBytes(32).toString("hex");
  const commitment = crypto
    .createHash("sha256")
    .update(Buffer.from(dataHash + blindingFactor, "utf8"))
    .digest("hex");
  return { commitment, blindingFactor };
}

/**
 * Verify that a commitment matches a known data hash and blinding factor.
 *
 * @param {string} commitment
 * @param {string} dataHash
 * @param {string} blindingFactor
 * @returns {boolean}
 */
export function verifyCommitment(commitment, dataHash, blindingFactor) {
  const expected = crypto
    .createHash("sha256")
    .update(Buffer.from(dataHash + blindingFactor, "utf8"))
    .digest("hex");
  return commitment === expected;
}
