import { clamp } from "./types.js";

export function decidePolicy(state, market, risk, config) {
  const reasons = [];

  const emergency =
    risk.oracleDivergence >= config.risk.oracleDivergenceCritical ||
    market.liquidityDepthUsd <= config.risk.liquidityCriticalUsd ||
    market.volatility24h >= config.risk.volatilityCritical ||
    risk.score >= 85;

  const shouldTighten = emergency || risk.score >= 60;
  const shouldRelax = !emergency && risk.score <= 30 && market.liquidityDepthUsd >= config.risk.liquidityWarnUsd;
  const resumeEligible =
    state.paused &&
    !emergency &&
    risk.score <= 25 &&
    market.volatility24h < config.risk.volatilityWarn &&
    market.liquidityDepthUsd >= config.risk.liquidityWarnUsd &&
    risk.oracleDivergence < config.risk.oracleDivergenceWarn &&
    market.topHolderShare < config.risk.concentrationWarn;

  if (risk.oracleDivergence >= config.risk.oracleDivergenceCritical) {
    reasons.push("oracle divergence above critical threshold");
  }
  if (market.liquidityDepthUsd <= config.risk.liquidityCriticalUsd) {
    reasons.push("market liquidity below critical depth");
  }
  if (market.topHolderShare >= config.risk.concentrationCritical) {
    reasons.push("collateral concentration too high");
  }
  if (market.volatility24h >= config.risk.volatilityCritical) {
    reasons.push("volatility regime is critical");
  }

  let next = { ...state };
  let action = "hold";

  if (emergency) {
    action = "pause-and-tighten";
    next.paused = true;
    next.maxLtvBps = clamp(
      state.maxLtvBps - config.policy.emergencyTightenStepBps,
      config.policy.minLtvBps,
      config.policy.maxLtvBps
    );
    next.mintCapUsd = Math.round(state.mintCapUsd * 0.7);
  } else if (resumeEligible) {
    action = "resume";
    next.paused = false;
    next.maxLtvBps = clamp(
      state.maxLtvBps + config.policy.tightenStepBps,
      config.policy.minLtvBps,
      config.policy.targetLtvBps
    );
    next.mintCapUsd = Math.round(Math.min(state.mintCapUsd * 1.1, config.policy.defaultMintCapUsd));
  } else if (shouldTighten) {
    action = "tighten";
    next.paused = false;
    next.maxLtvBps = clamp(
      state.maxLtvBps - config.policy.tightenStepBps,
      config.policy.minLtvBps,
      config.policy.maxLtvBps
    );
    next.mintCapUsd = Math.round(state.mintCapUsd * 0.85);
  } else if (shouldRelax) {
    action = "relax";
    next.paused = false;
    next.maxLtvBps = clamp(
      state.maxLtvBps + config.policy.tightenStepBps,
      config.policy.minLtvBps,
      config.policy.targetLtvBps
    );
    next.mintCapUsd = Math.round(Math.min(state.mintCapUsd * 1.15, config.policy.defaultMintCapUsd));
  }

  if (reasons.length === 0) {
    reasons.push("risk profile within expected bounds");
  }
  if (state.paused && action === "hold") {
    reasons.push("system remains paused until recovery thresholds are met");
  }

  next.version = state.version + 1;
  next.reason = reasons.join("; ");
  next.updatedAt = new Date().toISOString();

  return {
    action,
    confidence: emergency ? 0.93 : resumeEligible ? 0.86 : shouldTighten ? 0.8 : shouldRelax ? 0.72 : 0.66,
    rationale: reasons,
    nextState: next
  };
}
