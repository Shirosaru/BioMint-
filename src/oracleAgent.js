/**
 * BioMint Oracle Agent
 *
 * A standalone agent process that acts as the verifiable compute layer between
 * buyer evaluation requests and on-chain settlement.
 *
 * TRUST MODEL
 * ───────────
 * The main server (dataMarket.js) cannot approve a micropayment unilaterally.
 * Every settlement must carry a signature from THIS agent's Ed25519 key.
 *
 * The agent's public key is published at GET /pubkey so any third party can
 * verify that settlement attestations were produced by this specific agent
 * process and not by the market server itself.
 *
 * In production this agent would run inside a TEE (e.g. Phala Network, AWS
 * Nitro Enclave) so the private key is never visible to the operator.  For
 * the hackathon demo it runs as a local subprocess — the key separation is
 * real; the hardware isolation is the production upgrade path.
 *
 * ENDPOINTS
 * ─────────
 *  POST /evaluate     { tokenId, dataType, qualityScore, coverageDays?, modelTask }
 *    → { result, oracleSignature, oraclePubkey, evaluatedAt, agentVersion }
 *
 *  GET  /pubkey       → { oraclePubkey, agentVersion, startedAt }
 *
 *  GET  /health       → { ok: true }
 *
 * The result payload that is signed:
 *   { tokenId, modelTask, baselineMetric, newMetric, higherIsBetter,
 *     delta, worthPaying, evaluatedAt }
 *
 * dataMarket.js verifies the signature before any payment fires.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulateModelEvaluation, scoreImprovement } from "./modelOracle.js";
import { CONFIG } from "./config.js";

const AGENT_VERSION = "biomint-oracle-v1";

// ── Oracle keypair (separate from the main attestation agent keypair) ────────

const keyDir  = path.resolve(fileURLToPath(new URL("../data/keys", import.meta.url)));
const privPath = path.join(keyDir, "oracle_private.pem");
const pubPath  = path.join(keyDir, "oracle_public.pem");

function ensureOracleKeypair() {
  fs.mkdirSync(keyDir, { recursive: true });
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    return {
      privateKey: fs.readFileSync(privPath, "utf8"),
      publicKey:  fs.readFileSync(pubPath,  "utf8"),
    };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(pubPath,  publicKey.export({ type: "spki",  format: "pem" }));
  return {
    privateKey: fs.readFileSync(privPath, "utf8"),
    publicKey:  fs.readFileSync(pubPath,  "utf8"),
  };
}

const KEYS = ensureOracleKeypair();

/** Fingerprint of the oracle public key — used as a short identifier. */
const ORACLE_PUBKEY_HEX = crypto
  .createHash("sha256")
  .update(KEYS.publicKey)
  .digest("hex")
  .slice(0, 32);

// ── Signing helper ────────────────────────────────────────────────────────────

/**
 * Sign an object deterministically.
 * Returns base64-encoded Ed25519 signature over the canonical JSON.
 */
function sign(obj) {
  const payload = JSON.stringify(
    Object.keys(obj).sort().reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {})
  );
  return crypto.sign(null, Buffer.from(payload), KEYS.privateKey).toString("base64");
}

// ── Request handler ────────────────────────────────────────────────────────────

const START_TIME = new Date().toISOString();

function respond(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // ── GET /health ──────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/health") {
    return respond(res, 200, { ok: true });
  }

  // ── GET /pubkey ──────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/pubkey") {
    return respond(res, 200, {
      oraclePubkey: ORACLE_PUBKEY_HEX,
      agentVersion: AGENT_VERSION,
      startedAt:    START_TIME,
      note: "In production this key would be bound to a TEE attestation report.",
    });
  }

  // ── POST /evaluate ───────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/evaluate") {
    let body;
    try { body = await readBody(req); }
    catch { return respond(res, 400, { error: "Invalid JSON body" }); }

    const { tokenId, dataType, qualityScore, coverageDays, modelTask } = body ?? {};

    if (!tokenId || !dataType || qualityScore == null || !modelTask) {
      return respond(res, 400, { error: "Missing required fields: tokenId, dataType, qualityScore, modelTask" });
    }

    // Run the model evaluation (seeded — deterministic per tokenId)
    const evaluation = simulateModelEvaluation(
      { tokenId, qualityScore, coverageDays: coverageDays ?? null },
      modelTask
    );

    // Score the improvement and determine payment
    const score = scoreImprovement({
      tokenId,
      dataType,
      modelTask,
      baselineMetric: evaluation.baselineMetric,
      newMetric:      evaluation.newMetric,
      higherIsBetter: evaluation.higherIsBetter,
      qualityScore,
      coverageDays:   coverageDays ?? null,
    });

    // The payload that gets signed — this is what the market verifies
    const resultPayload = {
      tokenId,
      modelTask,
      baselineMetric: evaluation.baselineMetric,
      newMetric:      evaluation.newMetric,
      higherIsBetter: evaluation.higherIsBetter,
      delta:          score.delta,
      worthPaying:    score.worthPaying,
      paymentLamports: score.paymentLamports,
      evaluatedAt:    new Date().toISOString(),
    };

    const oracleSignature = sign(resultPayload);

    return respond(res, 200, {
      result:          resultPayload,
      score,
      oracleSignature,
      oraclePubkey:    ORACLE_PUBKEY_HEX,
      agentVersion:    AGENT_VERSION,
    });
  }

  respond(res, 404, { error: "Not found" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.ORACLE_PORT ?? "3100");

server.listen(PORT, "127.0.0.1", () => {
  // Signal readiness to the parent process (serve.js watches for this line)
  console.log(`BioMint Oracle Agent  port=${PORT}  pubkey=${ORACLE_PUBKEY_HEX}`);
});

server.on("error", (err) => {
  console.error("Oracle agent error:", err.message);
  process.exit(1);
});
