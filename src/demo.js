import { runPolicyStep, resetRuntimeState } from "./agent.js";
import { issueDelegation } from "./authorization.js";
import { CONFIG } from "./config.js";

const scenarios = [
  {
    name: "baseline-normal",
    market: {
      volatility24h: 0.07,
      liquidityDepthUsd: 540000,
      oraclePriceA: 100,
      oraclePriceB: 100.4,
      topHolderShare: 0.21
    }
  },
  {
    name: "volatility-spike",
    market: {
      volatility24h: 0.24,
      liquidityDepthUsd: 300000,
      oraclePriceA: 100,
      oraclePriceB: 101.1,
      topHolderShare: 0.28
    }
  },
  {
    name: "oracle-divergence-attack",
    market: {
      volatility24h: 0.16,
      liquidityDepthUsd: 240000,
      oraclePriceA: 100,
      oraclePriceB: 104.5,
      topHolderShare: 0.42
    }
  },
  {
    name: "liquidity-crunch",
    market: {
      volatility24h: 0.14,
      liquidityDepthUsd: 90000,
      oraclePriceA: 100,
      oraclePriceB: 102,
      topHolderShare: 0.57
    }
  }
];

console.log("== Agentic Mint Guard Stress Demo ==");

if (!process.argv.includes("--keep-state")) {
  const reset = resetRuntimeState();
  console.log("Runtime reset:");
  console.log(`  state=${reset.paths.state}`);
  console.log(`  attestations=${reset.paths.attestations}`);
}

function buildControls(name) {
  const baseLiability = name === "liquidity-crunch" ? 2600000 : 2200000;
  const baseCollateral =
    name === "oracle-divergence-attack"
      ? 2500000
      : name === "liquidity-crunch"
      ? 2350000
      : 3100000;

  return {
    request: { action: "mint", amountUsd: 120000 },
    backingSnapshot: {
      collateralUsd: baseCollateral,
      liabilityUsd: baseLiability,
      mintCapacityUsd: 3000000,
      reserveProofFresh: name !== "oracle-divergence-attack"
    },
    delegation: issueDelegation(
      {
        principal: "user-alpha",
        agentId: "agent-primary",
        permissions: ["mint", "trade"],
        maxMintUsd: 250000,
        maxTradeUsd: 180000,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      },
      CONFIG.auth.delegationSecret
    ),
    agents: [
      { id: "agent-primary", priority: 1, approves: true, lastHeartbeat: new Date().toISOString() },
      { id: "agent-backup-1", priority: 2, approves: true, lastHeartbeat: new Date().toISOString() },
      {
        id: "agent-backup-2",
        priority: 3,
        approves: name !== "oracle-divergence-attack",
        lastHeartbeat: new Date().toISOString()
      }
    ]
  };
}

for (const scenario of scenarios) {
  const outcome = runPolicyStep(scenario.market, buildControls(scenario.name));
  console.log(`\nScenario: ${scenario.name}`);
  console.log(`  action=${outcome.decision.action} confidence=${outcome.decision.confidence}`);
  console.log(`  riskScore=${outcome.risk.score} grade=${outcome.risk.grade}`);
  console.log(
    `  backingRatio=${outcome.backing.collateralRatio.toFixed(3)} authorized=${outcome.auth.allowed} leader=${outcome.executionPlan.leader}`
  );
  console.log(`  paused=${outcome.decision.nextState.paused} maxLtvBps=${outcome.decision.nextState.maxLtvBps} mintCapUsd=${outcome.decision.nextState.mintCapUsd}`);
  console.log(`  rationale=${outcome.decision.rationale.join(" | ")}`);
}

console.log("\nDemo complete. Check data/policy_state.json and data/attestations.ndjson.");
