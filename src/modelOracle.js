/**
 * Model improvement oracle — BioMint clinical data exchange.
 *
 * Bridges the gap between "patient submitted data" and "pharma/AI paid for it":
 *   1. Buyer declares a baseline model metric for a clinical prediction task
 *   2. They incorporate the new dataset and re-evaluate the same metric
 *   3. This oracle scores the delta and determines micropayment eligibility + amount
 *
 * Payment formula:
 *   pay = BASE_PAYMENT[dataType]
 *       × clamp(delta / threshold, 0, MAX_MULTIPLIER)   ← how much better
 *       × (0.5 + qualityScore)                          ← dataset completeness
 *       × coverageBonus                                 ← length of CGM record
 *
 * Real deployment:
 *   - The buyer submits (baselineMetric, newMetric) as a signed message from
 *     their ML evaluation environment.
 *   - An on-chain ZK verifier (e.g. Groth16 proof of gradient step) can
 *     replace the trust-in-buyer assumption in the current design.
 *   - Dispute window: 48 h during which the oracle can challenge the claim.
 */

// ── Task registry ────────────────────────────────────────────────────────────

export const ModelTask = Object.freeze({
  /** Predict next-60-min glucose value from last 3 h of CGM (RMSE metric, lower=better) */
  T2D_GLUCOSE_PREDICTION:     "T2D_GLUCOSE_PREDICTION",
  /** Binary classifier: will patient go hypoglycemic within 30 min? (AUC, higher=better) */
  HYPOGLYCEMIA_ALERT:         "HYPOGLYCEMIA_ALERT",
  /** Polygenic risk score for type-2 diabetes onset (AUC, higher=better) */
  GENOME_T2D_RISK:            "GENOME_T2D_RISK",
  /** Predict 12-week HbA1c reduction on Lilly's tirzepatide (AUC, higher=better) */
  DRUG_RESPONSE_TIRZEPATIDE:  "DRUG_RESPONSE_TIRZEPATIDE",
  /** Estimate insulin sensitivity index from CGM + lifestyle (RMSE %, lower=better) */
  INSULIN_SENSITIVITY:        "INSULIN_SENSITIVITY",
  /** Classify post-meal glucose spike phenotype (AUC, higher=better) */
  MEAL_SPIKE_PHENOTYPING:     "MEAL_SPIKE_PHENOTYPING",
  /** Predict whether a patient will mount a durable antibody response to a mAb or vaccine (AUC) */
  ANTIBODY_RESPONSE:          "ANTIBODY_RESPONSE",
  /** Classify autoimmune disease subtype / flare risk from cytokine + Ab panel (AUC) */
  AUTOIMMUNE_RISK:            "AUTOIMMUNE_RISK",
  /** Predict CRP/IL-6 trajectory from routine blood panels — inflammation monitoring (RMSE) */
  INFLAMMATION_TRAJECTORY:    "INFLAMMATION_TRAJECTORY",
});

// ── Task metadata ────────────────────────────────────────────────────────────

const TASK_META = {
  T2D_GLUCOSE_PREDICTION: {
    higherIsBetter: false,
    metric: "RMSE (mg/dL)",
    threshold: 0.004,      // absolute improvement in RMSE
    // Dataset types that feed this model
    compatibleTypes: ["CGM_TIMESERIES", "LIFESTYLE_CORR"],
  },
  HYPOGLYCEMIA_ALERT: {
    higherIsBetter: true,
    metric: "AUROC",
    threshold: 0.005,
    compatibleTypes: ["CGM_TIMESERIES", "LIBRE_FLASH"],
  },
  GENOME_T2D_RISK: {
    higherIsBetter: true,
    metric: "AUROC",
    threshold: 0.004,
    compatibleTypes: ["GENOME_VARIANT"],
  },
  DRUG_RESPONSE_TIRZEPATIDE: {
    higherIsBetter: true,
    metric: "AUROC",
    threshold: 0.006,
    compatibleTypes: ["GENOME_VARIANT", "CGM_TIMESERIES"],
  },
  INSULIN_SENSITIVITY: {
    higherIsBetter: false,
    metric: "RMSE (%)",
    threshold: 0.003,
    compatibleTypes: ["CGM_TIMESERIES", "LIFESTYLE_CORR"],
  },
  MEAL_SPIKE_PHENOTYPING: {
    higherIsBetter: true,
    metric: "AUROC",
    threshold: 0.005,
    compatibleTypes: ["CGM_TIMESERIES", "LIFESTYLE_CORR", "LIBRE_FLASH"],
  },
  ANTIBODY_RESPONSE: {
    higherIsBetter: true,
    metric: "AUROC",
    threshold: 0.002,
    compatibleTypes: ["IMMUNE_PANEL", "GENOME_VARIANT", "BLOOD_BIOMARKER"],
  },
  AUTOIMMUNE_RISK: {
    higherIsBetter: true,
    metric: "AUROC",
    threshold: 0.002,
    compatibleTypes: ["IMMUNE_PANEL", "GENOME_VARIANT"],
  },
  INFLAMMATION_TRAJECTORY: {
    higherIsBetter: false,
    metric: "RMSE (mg/L)",
    threshold: 0.003,
    compatibleTypes: ["BLOOD_BIOMARKER", "IMMUNE_PANEL", "LIFESTYLE_CORR"],
  },
};

// ── Payment schedule ─────────────────────────────────────────────────────────

/** Maximum payment multiplier cap — prevents runaway payouts from a single dataset. */
const MAX_MULTIPLIER = 3.0;

/**
 * Base micropayment per dataset batch (lamports).
 * At ~$150/SOL:
 *   CGM_TIMESERIES  100 000 lamps ≈ $0.015 base (typical run earns $0.02–0.05)
 *   GENOME_VARIANT  500 000 lamps ≈ $0.075 base (rare, high-value, earns $0.10–0.22)
 */
const BASE_PAYMENT_LAMPORTS = {
  CGM_TIMESERIES:  100_000,
  GENOME_VARIANT:  500_000,
  LIBRE_FLASH:      80_000,
  LIFESTYLE_CORR:  120_000,
  BLOOD_BIOMARKER: 150_000,  // ≈ $0.022 base — widely available, good longitudinal value
  IMMUNE_PANEL:    400_000,  // ≈ $0.060 base — scarce, high-value for mAb research
};

// ── Main scoring function ────────────────────────────────────────────────────

/**
 * Score a dataset's contribution to a model and determine micropayment.
 *
 * @param {object} opts
 * @param {string}  opts.tokenId          Dataset token ID
 * @param {string}  opts.dataType         DatasetType constant
 * @param {string}  opts.modelTask        ModelTask constant
 * @param {number}  opts.baselineMetric   Metric value BEFORE incorporating dataset
 * @param {number}  opts.newMetric        Metric value AFTER incorporating dataset
 * @param {boolean} opts.higherIsBetter   True for AUC/accuracy, false for RMSE/loss
 * @param {number}  opts.qualityScore     Dataset quality 0–1 from tokenizeDataset
 * @param {number}  [opts.coverageDays]   Days of CGM coverage (boosts payment)
 * @returns {ImprovementScore}
 */
export function scoreImprovement({
  tokenId,
  dataType,
  modelTask,
  baselineMetric,
  newMetric,
  higherIsBetter,
  qualityScore,
  coverageDays = null,
}) {
  const meta = TASK_META[modelTask];
  if (!meta) throw new Error(`Unknown model task: ${modelTask}`);

  const delta = higherIsBetter
    ? newMetric - baselineMetric   // positive = improvement for AUC
    : baselineMetric - newMetric;  // positive = improvement for RMSE (lower is better)

  const threshold = meta.threshold;
  const worthPaying = delta > threshold;

  const base = {
    tokenId,
    modelTask,
    metric: meta.metric,
    delta: Math.round(delta * 1_000_000) / 1_000_000,
    baselineMetric,
    newMetric,
    higherIsBetter,
    scoredAt: new Date().toISOString(),
  };

  if (!worthPaying) {
    return {
      ...base,
      worthPaying: false,
      paymentLamports: 0,
      reason: delta <= 0
        ? `Dataset degraded model (delta = ${(delta * 100).toFixed(4)}%) — no payment`
        : `Improvement ${(delta * 100).toFixed(4)}% < threshold ${(threshold * 100).toFixed(4)}% — no payment`,
    };
  }

  // Scale payment by how much better the model got
  const deltaMultiplier = Math.min(delta / threshold, MAX_MULTIPLIER);

  // Quality multiplier: 0.5× for zero-quality → 1.5× for perfect quality
  const qualityMultiplier = 0.5 + qualityScore;

  // Coverage bonus for long CGM records: 1× at 14 days, capped at 1.5× at 90 days
  const coverageBonus = coverageDays != null
    ? Math.min(1 + Math.max(coverageDays - 14, 0) / 152, 1.5)
    : 1.0;

  const basePay = BASE_PAYMENT_LAMPORTS[dataType] ?? 100_000;
  const paymentLamports = Math.round(
    basePay * deltaMultiplier * qualityMultiplier * coverageBonus
  );

  return {
    ...base,
    worthPaying: true,
    paymentLamports,
    deltaMultiplier: Math.round(deltaMultiplier * 100) / 100,
    qualityMultiplier: Math.round(qualityMultiplier * 100) / 100,
    coverageBonus: Math.round(coverageBonus * 100) / 100,
    reason: `Model improved ${(delta * 100).toFixed(4)}% — payment = ${(paymentLamports / 1e9).toFixed(7)} SOL`,
  };
}

// ── Simulated model evaluation (demo / testing) ──────────────────────────────

/**
 * Simulate model evaluation results for a dataset token.
 *
 * Uses the token ID as a deterministic seed so the same token always produces
 * the same simulated result — enabling reproducible demos.
 *
 * In production this would:
 *   - Call the buyer's ML evaluation endpoint (off-chain)
 *   - Return a signed evaluation attestation
 *   - Optionally include a ZK proof of correct gradient computation
 *
 * @param {object} datasetToken   From tokenizeDataset()
 * @param {string} modelTask      ModelTask constant
 * @returns {{ baselineMetric, newMetric, higherIsBetter, evaluatedAt }}
 */
export function simulateModelEvaluation(datasetToken, modelTask) {
  const meta = TASK_META[modelTask];
  if (!meta) throw new Error(`Unknown model task: ${modelTask}`);

  // Seeded PRNG from token ID
  let s = parseInt(datasetToken.tokenId.slice(0, 8), 16) ^ parseInt(datasetToken.tokenId.slice(8, 16), 16);
  const rand = () => {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };

  // Realistic baseline ranges per task
  const baselines = {
    T2D_GLUCOSE_PREDICTION:    { center: 18.5, spread: 3.0 },   // RMSE mg/dL
    HYPOGLYCEMIA_ALERT:        { center: 0.780, spread: 0.08 },  // AUC
    GENOME_T2D_RISK:           { center: 0.710, spread: 0.07 },  // AUC
    DRUG_RESPONSE_TIRZEPATIDE: { center: 0.650, spread: 0.10 },  // AUC
    INSULIN_SENSITIVITY:       { center: 22.1, spread: 4.0 },   // RMSE %
    MEAL_SPIKE_PHENOTYPING:    { center: 0.720, spread: 0.08 },  // AUC
    ANTIBODY_RESPONSE:         { center: 0.700, spread: 0.12 },  // AUC
    AUTOIMMUNE_RISK:           { center: 0.720, spread: 0.10 },  // AUC
    INFLAMMATION_TRAJECTORY:   { center: 4.80, spread: 1.20 },  // RMSE mg/L
  };

  const spec = baselines[modelTask] ?? { center: 0.7, spread: 0.1 };
  const baseline = spec.center + (rand() - 0.5) * spec.spread * 0.2;

  // Quality-weighted improvement delta: high-quality data moves the needle more
  // Coverage also boosts CGM impact (more temporal context)
  const coverageBonus = datasetToken.coverageDays
    ? Math.min(datasetToken.coverageDays / 30, 2)
    : 1;
  const maxImprovement = spec.spread * 0.06 * datasetToken.qualityScore * coverageBonus;
  const improvement = maxImprovement * rand();

  // ~25% chance of no meaningful improvement (dataset didn't help this particular model)
  const ineffective = rand() < 0.25;
  const actualImprovement = ineffective ? improvement * 0.1 : improvement;

  const newMetric = meta.higherIsBetter
    ? baseline + actualImprovement
    : baseline - actualImprovement;

  return {
    baselineMetric: Math.round(baseline * 10_000) / 10_000,
    newMetric: Math.round(newMetric * 10_000) / 10_000,
    higherIsBetter: meta.higherIsBetter,
    ineffective,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Return compatible model tasks for a given DatasetType.
 *
 * @param {string} dataType DatasetType constant
 * @returns {string[]} Array of compatible ModelTask constants
 */
export function compatibleTasks(dataType) {
  return Object.entries(TASK_META)
    .filter(([, meta]) => meta.compatibleTypes.includes(dataType))
    .map(([task]) => task);
}
