import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG } from "./config.js";

const keyDir = path.resolve(new URL("keys", CONFIG.dataDir).pathname);
const privPath = path.join(keyDir, "agent_private.pem");
const pubPath = path.join(keyDir, "agent_public.pem");
const attestPath = path.resolve(new URL("attestations.ndjson", CONFIG.dataDir).pathname);

function ensureKeypair() {
  fs.mkdirSync(keyDir, { recursive: true });

  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    return {
      privateKey: fs.readFileSync(privPath, "utf8"),
      publicKey: fs.readFileSync(pubPath, "utf8")
    };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" });

  fs.writeFileSync(privPath, privatePem);
  fs.writeFileSync(pubPath, publicPem);

  return { privateKey: privatePem, publicKey: publicPem };
}

function stableStringify(obj) {
  const sortValue = (value) => {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
          acc[key] = sortValue(value[key]);
          return acc;
        }, {});
    }
    return value;
  };

  return JSON.stringify(sortValue(obj));
}

export function signDecision(decisionRecord) {
  const keys = ensureKeypair();
  const payload = stableStringify(decisionRecord);
  const signature = crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64");

  const attestation = {
    ...decisionRecord,
    signature,
    signedAt: new Date().toISOString(),
    signer: crypto.createHash("sha256").update(keys.publicKey).digest("hex").slice(0, 16)
  };

  fs.mkdirSync(path.dirname(attestPath), { recursive: true });
  fs.appendFileSync(attestPath, `${JSON.stringify(attestation)}\n`);

  return attestation;
}

export function getAttestationPath() {
  return attestPath;
}

export function resetAttestations() {
  fs.mkdirSync(path.dirname(attestPath), { recursive: true });
  fs.writeFileSync(attestPath, "");
}
