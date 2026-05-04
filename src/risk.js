import { clamp } from "./types.js";

function normalizeInverse(value, warn, critical) {
  if (value >= warn) return 0;
  if (value <= critical) return 100;
  return clamp(((warn - value) / (warn - critical)) * 100, 0, 100);
}

function normalize(value, warn, critical) {
  if (value <= warn) return 0;
  if (value >= critical) return 100;
  return clamp(((value - warn) / (critical - warn)) * 100, 0, 100);
}

export function computeRisk(input, thresholds) {
  const oracleMid = (input.oraclePriceA + input.oraclePriceB) / 2;
  const oracleDivergence = Math.abs(input.oraclePriceA - input.oraclePriceB) / oracleMid;

  const components = {
    volatility: normalize(input.volatility24h, thresholds.volatilityWarn, thresholds.volatilityCritical),
    liquidity: normalizeInverse(input.liquidityDepthUsd, thresholds.liquidityWarnUsd, thresholds.liquidityCriticalUsd),
    oracleDivergence: normalize(oracleDivergence, thresholds.oracleDivergenceWarn, thresholds.oracleDivergenceCritical),
    concentration: normalize(input.topHolderShare, thresholds.concentrationWarn, thresholds.concentrationCritical)
  };

  const weighted =
    components.volatility * 0.3 +
    components.liquidity * 0.25 +
    components.oracleDivergence * 0.3 +
    components.concentration * 0.15;

  return {
    components,
    oracleDivergence,
    score: Math.round(weighted),
    grade: weighted >= 80 ? "critical" : weighted >= 60 ? "high" : weighted >= 35 ? "medium" : "low"
  };
}
