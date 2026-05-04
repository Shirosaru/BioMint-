/**
 * x402 payment client — autonomous agent-side payment flow.
 *
 * When an HTTP resource responds with 402 Payment Required, this client:
 *   1. Parses the X-Payment-Required header for payment requirements
 *   2. Builds and signs a Solana SOL transfer matching the requirements
 *   3. Retries the original request with the X-Payment signed header
 *
 * This is the client counterpart to x402Facilitator.js, inspired by
 * MCPay's x402-hook.ts and Latinum's wallet_mcp pattern.
 *
 * Required env vars:
 *   ADMIN_KEYPAIR_JSON      Paying agent's 64-byte keypair
 *   SOLANA_RPC_URL
 *
 * Usage:
 *   import { x402Fetch } from './x402Client.js';
 *   const data = await x402Fetch('https://api.example.com/oracle', { method: 'GET' });
 */

import { Keypair, Connection, SystemProgram, Transaction, PublicKey } from "@solana/web3.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Parse payment requirements from a 402 response.
 * Supports both X-Payment-Required header (JSON) and WWW-Authenticate: x402 header.
 */
function parsePaymentRequired(response) {
  // Try X-Payment-Required header first (x402 spec)
  const xpayHeader = response.headers.get("X-Payment-Required") ||
    response.headers.get("x-payment-required");
  if (xpayHeader) {
    try {
      return JSON.parse(xpayHeader);
    } catch { /* fall through */ }
  }

  // Try WWW-Authenticate: x402 <base64>
  const wwwAuth = response.headers.get("WWW-Authenticate") || "";
  if (wwwAuth.startsWith("x402 ")) {
    try {
      return JSON.parse(Buffer.from(wwwAuth.slice(5), "base64").toString());
    } catch { /* fall through */ }
  }

  // Try response body if content-type is JSON (some implementations put it there)
  return null;
}

/**
 * Build and sign a Solana SOL transfer for an x402 payment requirement.
 *
 * @param {object} requirement   - { payTo, maxAmountRequired, asset, network }
 * @param {Keypair} payer
 * @param {Connection} connection
 * @returns {Promise<string>}  Base64-encoded signed transaction
 */
async function buildX402Payment(requirement, payer, connection) {
  const { payTo, maxAmountRequired } = requirement;

  // maxAmountRequired is in lamports for SVM networks
  const amountLamports = Number(maxAmountRequired);

  const recipient = new PublicKey(payTo);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");

  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash,
    lastValidBlockHeight
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: amountLamports
    })
  );

  tx.sign(payer);
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * Encode payment as X-Payment header (x402 v1 format).
 * The header value is base64(JSON({ scheme, network, payload })).
 */
function encodePaymentHeader(requirement, signedTxB64) {
  const payload = {
    scheme: "exact",
    network: requirement.network ?? "solana-devnet",
    payload: signedTxB64
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * fetch() wrapper that automatically handles HTTP 402 responses.
 * Builds, signs, and replays the request with payment attached.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {object} [opts]
 * @param {string} [opts.rpcUrl]
 * @param {string} [opts.adminKeypairJson]
 * @returns {Promise<Response>}  The final response after payment
 */
export async function x402Fetch(url, init = {}, opts = {}) {
  const rpcUrl = opts.rpcUrl ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const keypairJson = opts.adminKeypairJson ?? process.env.ADMIN_KEYPAIR_JSON;

  // First attempt — no payment header
  const firstResponse = await fetch(url, init);

  if (firstResponse.status !== 402) {
    return firstResponse; // No payment needed
  }

  // Payment required
  const requirement = parsePaymentRequired(firstResponse);
  if (!requirement) {
    return firstResponse; // Can't parse — return 402 as-is
  }

  if (!keypairJson) {
    console.warn("[x402] 402 received but ADMIN_KEYPAIR_JSON not set — cannot pay");
    return firstResponse;
  }

  let payer;
  try {
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairJson)));
  } catch {
    console.warn("[x402] ADMIN_KEYPAIR_JSON malformed");
    return firstResponse;
  }

  const connection = new Connection(rpcUrl, "confirmed");

  try {
    const signedTxB64 = await buildX402Payment(requirement, payer, connection);
    const paymentHeader = encodePaymentHeader(requirement, signedTxB64);

    // Replay with payment
    const paidResponse = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "X-Payment": paymentHeader
      }
    });

    return paidResponse;
  } catch (err) {
    console.warn(`[x402] payment attempt failed: ${err.message}`);
    return firstResponse;
  }
}

/**
 * Check agent wallet balance (SOL).
 * @param {string} [keypairJson]
 * @param {string} [rpcUrl]
 * @returns {Promise<{publicKey: string, balanceSol: number, balanceLamports: number}>}
 */
export async function checkBalance(keypairJson, rpcUrl) {
  const kj = keypairJson ?? process.env.ADMIN_KEYPAIR_JSON;
  const rpc = rpcUrl ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

  if (!kj) return { publicKey: null, balanceSol: 0, balanceLamports: 0, error: "no keypair" };

  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(kj)));
  const connection = new Connection(rpc, "confirmed");
  const lamports = await connection.getBalance(payer.publicKey);
  return {
    publicKey: payer.publicKey.toBase58(),
    balanceLamports: lamports,
    balanceSol: lamports / LAMPORTS_PER_SOL
  };
}
