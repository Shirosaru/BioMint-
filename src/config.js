export const CONFIG = {
  risk: {
    volatilityWarn: 0.12,
    volatilityCritical: 0.22,
    oracleDivergenceWarn: 0.015,
    oracleDivergenceCritical: 0.03,
    liquidityWarnUsd: 350000,
    liquidityCriticalUsd: 140000,
    concentrationWarn: 0.35,
    concentrationCritical: 0.55
  },
  policy: {
    minLtvBps: 3500,
    targetLtvBps: 6000,
    maxLtvBps: 7200,
    defaultMintCapUsd: 2000000,
    tightenStepBps: 300,
    emergencyTightenStepBps: 700
  },
  backing: {
    minCollateralRatio: 1.2,
    emergencyCollateralRatio: 1.05,
    reserveHaircut: 0.97,
    maxUtilization: 0.92
  },
  auth: {
    // Demo-only secret for delegated capability signatures.
    delegationSecret: "mint-guard-demo-secret",
    maxDelegationHours: 24
  },
  autonomy: {
    minApprovals: 2,
    maxStaleHeartbeatSec: 45
  },
  dataDir: new URL("../data/", import.meta.url)
};
