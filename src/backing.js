import { clamp } from "./types.js";

export function evaluateBacking(snapshot, cfg) {
  const collateralValue = snapshot.collateralUsd * cfg.reserveHaircut;
  const liabilities = Math.max(snapshot.liabilityUsd, 1);
  const collateralRatio = collateralValue / liabilities;
  const utilization = liabilities / Math.max(snapshot.mintCapacityUsd, 1);

  const healthy =
    collateralRatio >= cfg.minCollateralRatio &&
    utilization <= cfg.maxUtilization &&
    snapshot.reserveProofFresh;

  const emergency =
    collateralRatio < cfg.emergencyCollateralRatio ||
    !snapshot.reserveProofFresh;

  const maxSafeMint = clamp(
    Math.floor(collateralValue / cfg.minCollateralRatio - liabilities),
    0,
    Number.MAX_SAFE_INTEGER
  );

  return {
    collateralRatio,
    utilization,
    healthy,
    emergency,
    maxSafeMintUsd: maxSafeMint,
    rationale: [
      collateralRatio < cfg.minCollateralRatio ? "collateral ratio below target" : null,
      collateralRatio < cfg.emergencyCollateralRatio ? "collateral ratio below emergency floor" : null,
      utilization > cfg.maxUtilization ? "mint utilization above limit" : null,
      !snapshot.reserveProofFresh ? "reserve proof stale" : null
    ].filter(Boolean)
  };
}
