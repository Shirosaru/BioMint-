import { CONFIG } from "./config.js";
import { computeRisk } from "./risk.js";
import { decidePolicy } from "./policyEngine.js";
import { loadState, saveState, getStatePath, resetState } from "./registry.js";
import { signDecision, getAttestationPath, resetAttestations } from "./attestation.js";
import { toPercent } from "./types.js";
import { evaluateBacking } from "./backing.js";
import { verifyDelegation, issueDelegation } from "./authorization.js";
import { selectExecutionPlan } from "./failover.js";

export function runPolicyStep(marketInput, controls = {}) {
  const normalizedControls = {
    request: controls.request ?? { action: "mint", amountUsd: 0 },
    backingSnapshot:
      controls.backingSnapshot ?? {
        collateralUsd: 0,
        liabilityUsd: 1,
        mintCapacityUsd: 1,
        reserveProofFresh: false
      },
    delegation:
      controls.delegation ??
      issueDelegation(
        {
          principal: "unknown",
          agentId: "unknown",
          permissions: [],
          maxMintUsd: 0,
          maxTradeUsd: 0,
          expiresAt: new Date(Date.now() - 1000).toISOString()
        },
        CONFIG.auth.delegationSecret
      ),
    agents: controls.agents ?? []
  };

  const currentState = loadState();
  const risk = computeRisk(marketInput, CONFIG.risk);
  const decision = decidePolicy(currentState, marketInput, risk, CONFIG);

  const backing = evaluateBacking(normalizedControls.backingSnapshot, CONFIG.backing);
  const auth = verifyDelegation(
    normalizedControls.delegation,
    normalizedControls.request,
    CONFIG.auth.delegationSecret
  );
  const executionPlan = selectExecutionPlan(normalizedControls.agents, CONFIG.autonomy);

  if (!auth.allowed) {
    decision.action = "deny";
    decision.confidence = 0.99;
    decision.rationale = [...decision.rationale, `authorization denied: ${auth.reason}`];
  }

  if (!executionPlan.ok) {
    decision.action = "failover-block";
    decision.confidence = 0.99;
    decision.rationale = [...decision.rationale, `execution blocked: ${executionPlan.reason}`];
  }

  if (backing.emergency) {
    decision.action = "pause-and-tighten";
    decision.confidence = 0.99;
    decision.nextState.paused = true;
    decision.nextState.maxLtvBps = Math.min(decision.nextState.maxLtvBps, 4000);
    decision.nextState.mintCapUsd = Math.min(decision.nextState.mintCapUsd, backing.maxSafeMintUsd);
    const seen = new Set(decision.rationale);
    for (const r of [...backing.rationale, "backing emergency override applied"]) {
      if (!seen.has(r)) { seen.add(r); decision.rationale.push(r); }
    }
  } else if (!backing.healthy) {
    decision.nextState.mintCapUsd = Math.min(decision.nextState.mintCapUsd, backing.maxSafeMintUsd);
    const seen = new Set(decision.rationale);
    for (const r of backing.rationale) {
      if (!seen.has(r)) { seen.add(r); decision.rationale.push(r); }
    }
  }

  saveState(decision.nextState);

  const record = {
    market: marketInput,
    controls: normalizedControls,
    risk,
    backing,
    auth,
    executionPlan,
    decision: {
      action: decision.action,
      confidence: decision.confidence,
      rationale: decision.rationale,
      nextState: decision.nextState
    }
  };

  const attested = signDecision(record);

  return {
    currentState,
    risk,
    backing,
    auth,
    executionPlan,
    decision,
    attested,
    paths: {
      state: getStatePath(),
      attestations: getAttestationPath()
    }
  };
}

export function resetRuntimeState() {
  const state = resetState();
  resetAttestations();
  return {
    state,
    paths: {
      state: getStatePath(),
      attestations: getAttestationPath()
    }
  };
}

function printSummary(outcome) {
  console.log("Action:", outcome.decision.action);
  console.log("Confidence:", outcome.decision.confidence);
  console.log("Risk score:", outcome.risk.score, `(${outcome.risk.grade})`);
  console.log("Backing:");
  console.log("  Collateral ratio:", outcome.backing.collateralRatio.toFixed(3));
  console.log("  Utilization:", toPercent(outcome.backing.utilization));
  console.log("  Max safe mint USD:", outcome.backing.maxSafeMintUsd);
  console.log("Auth/execution:");
  console.log("  authorized:", outcome.auth.allowed);
  console.log("  leader:", outcome.executionPlan.leader ?? "none");
  console.log("  approvals:", outcome.executionPlan.approvals);
  console.log("Signals:");
  console.log("  Volatility:", toPercent(outcome.attested.market.volatility24h));
  console.log("  Liquidity depth USD:", outcome.attested.market.liquidityDepthUsd);
  console.log("  Oracle divergence:", toPercent(outcome.risk.oracleDivergence));
  console.log("  Top holder share:", toPercent(outcome.attested.market.topHolderShare));
  console.log("Next state:", outcome.decision.nextState);
  console.log("State file:", outcome.paths.state);
  console.log("Attestations file:", outcome.paths.attestations);
}

if (process.argv.includes("--once")) {
  if (process.argv.includes("--reset")) {
    const reset = resetRuntimeState();
    console.log("Reset state:", reset.paths.state);
    console.log("Reset attestations:", reset.paths.attestations);
  }

  const sample = {
    volatility24h: 0.18,
    liquidityDepthUsd: 260000,
    oraclePriceA: 100,
    oraclePriceB: 101.8,
    topHolderShare: 0.39
  };

  const controls = {
    request: { action: "mint", amountUsd: 120000 },
    backingSnapshot: {
      collateralUsd: 3100000,
      liabilityUsd: 2200000,
      mintCapacityUsd: 3000000,
      reserveProofFresh: true
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
      { id: "agent-backup-2", priority: 3, approves: false, lastHeartbeat: new Date().toISOString() }
    ]
  };

  const outcome = runPolicyStep(sample, controls);
  printSummary(outcome);
}
