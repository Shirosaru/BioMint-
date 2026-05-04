/**
 * Autonomous polling loop — runs the policy engine continuously using
 * live oracle data and optionally submits decisions on-chain.
 *
 * Usage:
 *   node src/loop.js [--reset] [--dry-run]
 *
 * Env vars:
 *   POLL_INTERVAL_MS        Tick frequency (default: 30000)
 *   COLLATERAL_USD          Reserve collateral value (default: 1500000)
 *   LIABILITY_USD           Outstanding liability in USD (default: 1000000)
 *   MINT_CAPACITY_USD       Max mint capacity (default: 2000000)
 *   RESERVE_PROOF_FRESH     "true" | "false" (default: "true")
 *   SOLANA_RPC_URL          RPC endpoint for on-chain submission
 *   ADMIN_KEYPAIR_JSON      64-byte keypair for signing transactions
 *   POLICY_STATE_ADDRESS    PolicyState account address
 *
 * The loop never crashes on transient oracle failures — errors are logged
 * and the next tick proceeds with the last known good data.
 */

import { runPolicyStep, resetRuntimeState } from "./agent.js";
import { fetchMarketInput } from "./oracleAdapter.js";
import { issueDelegation } from "./authorization.js";
import { CONFIG } from "./config.js";
import { toPercent } from "./types.js";
import { executeSwap, swapIntentForAction } from "./swapExecutor.js";
import { fetchCrossChainCollateral } from "./wormholeAdapter.js";

const USE_WORMHOLE = process.env.USE_WORMHOLE_COLLATERAL === "true";
const USE_SWAPS = process.env.USE_SWAPS === "true";

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "30000");
const DRY_RUN = process.argv.includes("--dry-run");

// ── Controls builder (auto-issued delegation + liveness agents) ───────────────

async function buildLoopControls(market) {
  let collateralUsd = parseFloat(process.env.COLLATERAL_USD ?? "1500000");
  let liabilityUsd = parseFloat(process.env.LIABILITY_USD ?? "1000000");
  let mintCapacityUsd = parseFloat(process.env.MINT_CAPACITY_USD ?? "2000000");
  let reserveProofFresh = (process.env.RESERVE_PROOF_FRESH ?? "true") === "true";

  // ── Wormhole cross-chain collateral (opt-in via USE_WORMHOLE_COLLATERAL=true) ──
  if (USE_WORMHOLE) {
    try {
      const xchain = await fetchCrossChainCollateral({
        solPriceUsd: market.oraclePriceA,
        liabilityUsd,
        mintCapacityUsd
      });
      collateralUsd = xchain.collateralUsd;
      reserveProofFresh = xchain.reserveProofFresh;
      console.log(
        `  [wormhole] collateral=$${(collateralUsd / 1_000).toFixed(0)}k ` +
        `fresh=${reserveProofFresh} source=${xchain.sourceChain}`
      );
    } catch (err) {
      console.warn(`  [wormhole] failed: ${err.message}`);
    }
  }

  // Issue a fresh 1-hour delegation for the loop agent on every tick so it
  // never expires mid-run.
  const delegation = issueDelegation(
    {
      principal: "loop-operator",
      agentId: "loop-agent-001",
      permissions: ["mint", "trade", "policy"],
      maxMintUsd: mintCapacityUsd,
      maxTradeUsd: mintCapacityUsd * 0.5,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    },
    CONFIG.auth.delegationSecret
  );

  const now = Date.now();
  const agents = [
    { id: "agent-primary", lastHeartbeatMs: now, role: "primary", canApprove: true },
    { id: "agent-backup-1", lastHeartbeatMs: now - 8_000, role: "backup", canApprove: true },
    { id: "agent-backup-2", lastHeartbeatMs: now - 15_000, role: "backup", canApprove: true }
  ];

  return {
    request: { action: "mint", amountUsd: 100_000 },
    backingSnapshot: { collateralUsd, liabilityUsd, mintCapacityUsd, reserveProofFresh },
    delegation,
    agents
  };
}

// ── Single tick ───────────────────────────────────────────────────────────────

async function tick() {
  const market = await fetchMarketInput("SOL");

  if (market._meta?.errors?.length) {
    console.warn("  [oracle warnings]", market._meta.errors.join(" | "));
  }

  const controls = await buildLoopControls(market);
  const outcome = runPolicyStep(market, controls);

  const ts = new Date().toISOString();
  const { decision, risk, backing, auth, executionPlan } = outcome;

  console.log(
    `[${ts}] action=${decision.action.padEnd(20)} ` +
      `risk=${String(risk.score).padStart(2)}(${risk.grade.padEnd(8)}) ` +
      `backing=${backing.collateralRatio.toFixed(3)} ` +
      `auth=${auth.allowed ? "ok" : "DENIED"} ` +
      `leader=${executionPlan.leader ?? "none"}`
  );
  console.log(
    `  prices A=${market.oraclePriceA.toFixed(4)} B=${market.oraclePriceB.toFixed(4)} ` +
      `vol=${toPercent(market.volatility24h)} ` +
      `liq=$${(market.liquidityDepthUsd / 1_000).toFixed(0)}k ` +
      `maxMint=$${(backing.maxSafeMintUsd / 1_000).toFixed(0)}k`
  );

  // ── On-chain policy submission ────────────────────────────────────────────
  if (!DRY_RUN && (process.env.ADMIN_KEYPAIR_JSON || process.env.POLICY_STATE_ADDRESS)) {
    const { submitOnChain } = await import("./onchain.js");
    const chain = await submitOnChain(decision.nextState);
    if (chain.skipped) {
      console.log(`  [chain] ${chain.reason}`);
    } else if (chain.simulated) {
      const err = chain.err ? ` err=${JSON.stringify(chain.err)}` : "";
      console.log(`  [chain] simulated${err} logs=${chain.logs?.length ?? 0}`);
    } else if (chain.signature) {
      console.log(`  [chain] confirmed tx=${chain.signature}`);
    } else if (chain.error) {
      console.log(`  [chain] ERROR: ${chain.error}`);
    }
  }

  // ── Jupiter hedge swap (opt-in via USE_SWAPS=true + keypair set) ──────────
  if (!DRY_RUN && USE_SWAPS && swapIntentForAction(decision.action)) {
    const swap = await executeSwap({
      action: decision.action,
      amountUsd: Math.min(backing.maxSafeMintUsd * 0.05, 5_000), // hedge 5% of safe mint, max $5k
      oraclePriceA: market.oraclePriceA
    });
    if (swap.skipped) {
      console.log(`  [swap] ${swap.reason}`);
    } else if (swap.error) {
      console.log(`  [swap] ERROR: ${swap.error}`);
    } else {
      console.log(
        `  [swap] ${swap.direction} ${swap.inputMint}→${swap.outputMint} ` +
        `in=${swap.inputAmount} out=${swap.outAmount} tx=${swap.signature?.slice(0, 16)}…`
      );
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  if (process.argv.includes("--reset")) {
    const r = resetRuntimeState();
    console.log(`[init] state reset: ${r.paths.state}`);
  }

  const mode = DRY_RUN ? "DRY-RUN (no on-chain submission)" : "LIVE";
  console.log(`[init] Autonomous mint-guard loop — mode=${mode}`);
  console.log(`[init] Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[init] RPC: ${process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com (default)"}`);
  console.log(`[init] Keypair set: ${!!process.env.ADMIN_KEYPAIR_JSON}`);
  console.log(`[init] Policy state: ${process.env.POLICY_STATE_ADDRESS ?? "(not set — simulation only)"}`);
  console.log(`[init] Wormhole collateral: ${USE_WORMHOLE ? "ON" : "off (set USE_WORMHOLE_COLLATERAL=true to enable)"}`);
  console.log(`[init] Jupiter swaps: ${USE_SWAPS ? "ON" : "off (set USE_SWAPS=true to enable)"}`);
  console.log("─".repeat(80));

  process.on("SIGINT", () => {
    console.log("\n[loop] Stopped by SIGINT.");
    process.exit(0);
  });

  // Immediate first tick, then poll
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error(`[tick error] ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

run();
