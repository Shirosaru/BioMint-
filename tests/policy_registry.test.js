/**
 * Integration test for policy_registry Anchor program.
 * Runs against devnet (or localnet if SOLANA_RPC_URL=http://127.0.0.1:8899).
 *
 * Prerequisites:
 *   - Anchor program deployed; POLICY_PROGRAM_ID env var set
 *   - Admin keypair in data/admin-keypair.json
 *   - At minimum 0.1 SOL in admin wallet (for rent + tx fees)
 *
 * Run: node tests/policy_registry.test.js
 *  or: anchor test  (via Anchor.toml [scripts] test =)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.POLICY_PROGRAM_ID ??
  "7XT3UzsbuaPU9KsecRpC9EsGP7sX8QKuxPPgUtxFk1Pn"
);
const KEYPAIR_FILE = new URL("../data/admin-keypair.json", import.meta.url).pathname;

// ── Helpers ───────────────────────────────────────────────────────────────────
function disc(name) {
  // Anchor instruction discriminator: first 8 bytes of SHA256("global:<name>")
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u16LE(n) {
  const b = Buffer.alloc(2); b.writeUInt16LE(n); return b;
}
function u64LE(n) {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b;
}

function buildInitializeIx(admin, policyState, maxLtvBps, mintCapUsd) {
  const data = Buffer.concat([
    disc("initialize"),
    u16LE(maxLtvBps),
    u64LE(mintCapUsd)
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey,  isSigner: true,  isWritable: true },
      { pubkey: policyState,      isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    data
  });
}

function buildApplyPolicyIx(admin, policyState, paused, maxLtvBps, mintCapUsd) {
  const data = Buffer.concat([
    disc("apply_policy"),
    Buffer.from([paused ? 1 : 0]),
    u16LE(maxLtvBps),
    u64LE(mintCapUsd)
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true,  isWritable: false },
      { pubkey: policyState,     isSigner: false, isWritable: true  }
    ],
    data
  });
}

async function pass(label) { console.log(`  ✓ ${label}`); }
async function fail(label, err) { console.error(`  ✗ ${label}: ${err.message}`); process.exitCode = 1; }

// ── Tests ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n=== policy_registry on-chain tests ===");
  console.log(`  RPC:     ${RPC_URL}`);
  console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

  if (!existsSync(KEYPAIR_FILE)) {
    console.error(`  Keypair not found: ${KEYPAIR_FILE}`);
    console.error("  Run ./setup.sh first to generate a keypair.");
    process.exit(1);
  }
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_FILE, "utf8")))
  );
  console.log(`  Admin:   ${admin.publicKey.toBase58()}`);

  const conn = new Connection(RPC_URL, "confirmed");

  // Check balance
  const balLamports = await conn.getBalance(admin.publicKey);
  console.log(`  Balance: ${(balLamports / 1e9).toFixed(4)} SOL`);
  if (balLamports < 50_000_000) {
    console.warn("  Warning: low balance — may not cover rent + fees");
  }

  // Derive PDA for policy state
  const [policyState, bump] = await PublicKey.findProgramAddress(
    [Buffer.from("policy-state"), admin.publicKey.toBuffer()],
    PROGRAM_ID
  );
  console.log(`  PolicyState PDA: ${policyState.toBase58()} (bump ${bump})\n`);

  // ── Test 1: initialize ──────────────────────────────────────────────────────
  let alreadyInitialized = false;
  try {
    const existing = await conn.getAccountInfo(policyState);
    if (existing && existing.data.length > 0) {
      alreadyInitialized = true;
      await pass("initialize (account already exists — skipping)");
    } else {
      const ix = buildInitializeIx(admin, policyState, 6000, 2_000_000);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
      await pass(`initialize — txid ${sig.slice(0, 16)}…`);
    }
  } catch (e) {
    await fail("initialize", e);
    return; // can't continue without init
  }

  // ── Test 2: read state after init ───────────────────────────────────────────
  try {
    const info = await conn.getAccountInfo(policyState);
    if (!info || info.data.length < 8 + 32 + 1 + 2 + 8 + 8 + 8) {
      throw new Error(`unexpected account size ${info?.data.length}`);
    }
    // Skip 8-byte discriminator; parse fields
    const d = info.data;
    const adminKey = new PublicKey(d.subarray(8, 40)).toBase58();
    const paused   = d[40] === 1;
    const maxLtv   = d.readUInt16LE(41);
    const mintCap  = Number(d.readBigUInt64LE(43));
    const version  = Number(d.readBigUInt64LE(51));
    if (!alreadyInitialized) {
      if (adminKey !== admin.publicKey.toBase58()) throw new Error("admin mismatch");
      if (paused)    throw new Error("should not be paused after init");
      if (maxLtv !== 6000) throw new Error(`maxLtvBps mismatch: got ${maxLtv}`);
      if (mintCap !== 2_000_000) throw new Error(`mintCap mismatch: got ${mintCap}`);
    }
    await pass(`read state — version=${version} paused=${paused} maxLtv=${maxLtv}`);
  } catch (e) {
    await fail("read state", e);
  }

  // ── Test 3: apply_policy ────────────────────────────────────────────────────
  try {
    const ix = buildApplyPolicyIx(admin, policyState, true, 4000, 500_000);
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [admin]);
    await pass(`apply_policy (pause+tighten) — txid ${sig.slice(0, 16)}…`);
  } catch (e) {
    await fail("apply_policy", e);
  }

  // ── Test 4: verify updated state ────────────────────────────────────────────
  try {
    const info = await conn.getAccountInfo(policyState);
    const d = info.data;
    const paused   = d[40] === 1;
    const maxLtv   = d.readUInt16LE(41);
    const mintCap  = Number(d.readBigUInt64LE(43));
    const version  = Number(d.readBigUInt64LE(51));
    if (!paused)   throw new Error("expected paused=true");
    if (maxLtv !== 4000) throw new Error(`maxLtvBps: expected 4000 got ${maxLtv}`);
    if (mintCap !== 500_000) throw new Error(`mintCap: expected 500000 got ${mintCap}`);
    await pass(`state after apply_policy — version=${version} paused=${paused} maxLtv=${maxLtv} mintCap=${mintCap}`);
  } catch (e) {
    await fail("verify updated state", e);
  }

  // ── Test 5: apply_policy resume ─────────────────────────────────────────────
  try {
    const ix = buildApplyPolicyIx(admin, policyState, false, 6000, 2_000_000);
    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(conn, tx, [admin]);
    await pass("apply_policy (resume + relax)");
  } catch (e) {
    await fail("apply_policy resume", e);
  }

  console.log("\n=== done ===\n");
}

main().catch(e => { console.error(e); process.exit(1); });
