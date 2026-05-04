/**
 * on-chain wiring for the Anchor policy_registry program.
 *
 * Uses only @solana/web3.js (v1) + node:crypto — no Anchor client needed.
 * Instruction encoding is manual: Anchor discriminator (8 bytes of
 * sha256("global:<ix_name>")) followed by borsh-encoded arguments.
 *
 * Required env vars:
 *   SOLANA_RPC_URL          RPC endpoint (default: devnet)
 *   ADMIN_KEYPAIR_JSON      JSON array of 64 secret-key bytes
 *   POLICY_STATE_ADDRESS    On-chain PolicyState account pubkey
 *
 * If ADMIN_KEYPAIR_JSON is absent the function returns { skipped: true }.
 * If POLICY_STATE_ADDRESS is absent but a keypair is present, the
 * transaction is simulated (dry-run) and logs are returned.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import { createHash } from "node:crypto";

// ── The program ID declared in policy_registry_anchor.rs ──────────────────────
const PROGRAM_ID = new PublicKey("MintGuard1111111111111111111111111111111111");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute the 8-byte Anchor instruction discriminator. */
function anchorDiscriminator(ixName) {
  const full = createHash("sha256").update(`global:${ixName}`).digest();
  return Buffer.from(full).subarray(0, 8);
}

/**
 * Encode the `apply_policy` instruction data buffer.
 *
 * Layout:
 *   [0..8)  discriminator  (8 bytes)
 *   [8]     paused         (u8  / bool)
 *   [9..11) max_ltv_bps    (u16 LE)
 *   [11..19)mint_cap_usd   (u64 LE)
 */
function encodeApplyPolicy(paused, maxLtvBps, mintCapUsd) {
  const disc = anchorDiscriminator("apply_policy");
  const buf = Buffer.alloc(8 + 1 + 2 + 8);
  disc.copy(buf, 0);
  buf.writeUInt8(paused ? 1 : 0, 8);
  buf.writeUInt16LE(maxLtvBps, 9);
  buf.writeBigUInt64LE(BigInt(Math.round(mintCapUsd)), 11);
  return buf;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Submit (or simulate) an `apply_policy` instruction.
 *
 * @param {object} nextState   - { paused, maxLtvBps, mintCapUsd }
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function submitOnChain(nextState, opts = {}) {
  const rpcUrl = opts.rpcUrl ?? process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const keypairJson = opts.adminKeypairJson ?? process.env.ADMIN_KEYPAIR_JSON;
  const policyStateAddress = opts.policyStateAddress ?? process.env.POLICY_STATE_ADDRESS;

  // ── Dry-run mode: no keypair set ─────────────────────────────────────────
  if (!keypairJson) {
    return {
      skipped: true,
      reason: "ADMIN_KEYPAIR_JSON not set — on-chain submission skipped (offline mode)"
    };
  }

  let admin;
  try {
    admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairJson)));
  } catch {
    return { skipped: true, reason: "ADMIN_KEYPAIR_JSON is malformed" };
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const data = encodeApplyPolicy(nextState.paused, nextState.maxLtvBps, nextState.mintCapUsd);

  // ── Simulation mode: keypair available but no on-chain account yet ────────
  if (!policyStateAddress) {
    // Build a fake placeholder account for simulation purposes
    const placeholder = Keypair.generate().publicKey;
    const ix = buildIx(admin.publicKey, placeholder, data);
    const tx = new Transaction().add(ix);
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const sim = await connection.simulateTransaction(tx, [admin]);
    return {
      skipped: false,
      simulated: true,
      rpcUrl,
      logs: sim.value.logs ?? [],
      err: sim.value.err ?? null
    };
  }

  // ── Full submission ────────────────────────────────────────────────────────
  const policyStatePk = new PublicKey(policyStateAddress);
  const ix = buildIx(admin.publicKey, policyStatePk, data);
  const tx = new Transaction().add(ix);

  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [admin], {
      commitment: "confirmed"
    });
    return { skipped: false, simulated: false, rpcUrl, signature };
  } catch (err) {
    return { skipped: false, simulated: false, rpcUrl, error: err.message };
  }
}

function buildIx(adminPk, policyStatePk, data) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: adminPk, isSigner: true, isWritable: false },
      { pubkey: policyStatePk, isSigner: false, isWritable: true }
    ],
    data
  });
}
