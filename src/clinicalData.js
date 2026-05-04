/**
 * Clinical dataset tokenization — BioMint health data exchange hub.
 *
 * Supported dataset types:
 *   CGM_TIMESERIES   — Continuous Glucose Monitor (Dexcom G6/G7, Abbott FreeStyle Libre 3)
 *   GENOME_VARIANT   — Patient genomic SNP panel focused on T2D-risk and immune loci
 *   LIBRE_FLASH      — FreeStyle Libre flash-glucose scan sessions (on-demand reads)
 *   LIFESTYLE_CORR   — Paired CGM + lifestyle signals (diet, activity, sleep)
 *   BLOOD_BIOMARKER  — Routine blood panel: HbA1c, CRP, lipids, CBC, ferritin (any person)
 *   IMMUNE_PANEL     — Antibody titres, cytokine levels, T/B cell counts for therapeutic research
 *
 * The tokenizer:
 *   1. Validates dataset completeness and quality against minimum gates
 *   2. Computes a Merkle root of the reading/variant array (content-addressable)
 *   3. Derives a pseudonymous contributor ID from the consent token (non-reversible)
 *   4. Returns a DatasetToken — a lightweight metadata envelope, never the raw data
 *
 * Raw data remains off-chain (patient device / IPFS); only the token goes on-chain.
 */

import crypto from "node:crypto";

// ── Dataset type registry ────────────────────────────────────────────────────

export const DatasetType = Object.freeze({
  CGM_TIMESERIES:  "CGM_TIMESERIES",
  GENOME_VARIANT:  "GENOME_VARIANT",
  LIBRE_FLASH:     "LIBRE_FLASH",
  LIFESTYLE_CORR:  "LIFESTYLE_CORR",
  BLOOD_BIOMARKER: "BLOOD_BIOMARKER",  // routine labs — any patient, any condition
  IMMUNE_PANEL:    "IMMUNE_PANEL",     // antibody / cytokine / cell-count data
});

// ── Quality gates (minimum requirements per type) ───────────────────────────

const QUALITY_GATE = {
  CGM_TIMESERIES: {
    minReadings:        288,   // 24 h at 5-min intervals
    maxGapMinutes:       15,   // no sensor gap longer than this
    minCalibrationPct:   95,   // % of readings with calibration flag set
  },
  GENOME_VARIANT: {
    minVariants:         50,
    requiredConsentCode: "GENOME_RESEARCH",
  },
  LIBRE_FLASH: {
    minScans:            24,
    minCoverageDays:      7,
  },
  LIFESTYLE_CORR: {
    minReadings:        144,   // 12 h minimum
    requiresPairedActivity: true,
  },
  BLOOD_BIOMARKER: {
    minPanels:            1,   // at least one full blood draw result
    requiredMarkers: ["hba1c", "crp", "ldl"],  // must include these core markers
  },
  IMMUNE_PANEL: {
    minMeasurements:      5,   // at least 5 distinct analytes
    requiredAnalytes: ["igg"],  // must have at least IgG titre
  },
};

// ── Well-known T2D genomic loci (for variant relevance scoring) ──────────────

const T2D_LOCI = new Set([
  "rs7903146",   // TCF7L2   — strongest T2D GWAS signal
  "rs1801282",   // PPARG    — insulin sensitiser target
  "rs5219",      // KCNJ11   — ATP-sensitive K+ channel (sulfonylurea target)
  "rs13266634",  // SLC30A8  — zinc transporter in beta cells
  "rs7754840",   // CDKAL1   — CDK5 regulatory subunit
  "rs4402960",   // IGF2BP2  — mRNA binding protein
  "rs10811661",  // CDKN2A/B — cell cycle regulator
  "rs8050136",   // FTO      — fat mass / obesity locus
  "rs1111875",   // HHEX/IDE — islet transcription factor
  "rs4607517",   // GCK      — glucokinase (glucose sensor of beta cell)
  "rs10923931",  // NOTCH2   — pancreatic progenitor signalling
  "rs340874",    // PROX1    — hepatocyte transcription factor
]);

// ── Merkle tree helpers ──────────────────────────────────────────────────────

/**
 * Compute a Merkle root over an ordered array of arbitrary items.
 * Each leaf = SHA-256(JSON.stringify(item)).
 *
 * @param {any[]} items
 * @returns {string} Hex root hash
 */
function merkleRoot(items) {
  if (items.length === 0) return crypto.createHash("sha256").update("empty").digest("hex");

  let leaves = items.map(item =>
    crypto.createHash("sha256").update(JSON.stringify(item)).digest()
  );

  while (leaves.length > 1) {
    if (leaves.length % 2 !== 0) leaves.push(leaves[leaves.length - 1]);
    const next = [];
    for (let i = 0; i < leaves.length; i += 2) {
      next.push(
        crypto.createHash("sha256")
          .update(Buffer.concat([leaves[i], leaves[i + 1]]))
          .digest()
      );
    }
    leaves = next;
  }

  return leaves[0].toString("hex");
}

// ── Per-type validators ──────────────────────────────────────────────────────

/**
 * Validate a CGM timeseries.
 *
 * Expected reading shape:
 *   { ts: number (epoch ms), glucoseMgDl: number, calibrated: boolean }
 *
 * Also accepts Dexcom EGV shape:
 *   { systemTime: string, egv: number, trend: string }
 *   → normalised internally.
 */
function validateCgm(readings, deviceModel) {
  const gate = QUALITY_GATE.CGM_TIMESERIES;

  // Normalise Dexcom EGV format
  const normalised = readings.map((r, i) => {
    if (r.egv !== undefined) {
      return {
        ts: r.systemTime ? new Date(r.systemTime).getTime() : Date.now() - (readings.length - i) * 300_000,
        glucoseMgDl: r.egv,
        calibrated: r.trend !== "None",
        trend: r.trend,
      };
    }
    return r;
  });

  if (normalised.length < gate.minReadings) {
    throw new Error(
      `CGM dataset needs ≥${gate.minReadings} readings (got ${normalised.length}). ` +
      `That's 24 h of 5-min Dexcom/Libre data.`
    );
  }

  const sorted = [...normalised].sort((a, b) => a.ts - b.ts);

  // Gap check
  for (let i = 1; i < sorted.length; i++) {
    const gapMin = (sorted[i].ts - sorted[i - 1].ts) / 60_000;
    if (gapMin > gate.maxGapMinutes) {
      throw new Error(
        `Sensor gap of ${gapMin.toFixed(1)} min at index ${i} exceeds ${gate.maxGapMinutes}-min limit. ` +
        `Split into separate sessions before tokenizing.`
      );
    }
  }

  // Calibration coverage
  const calibratedPct = (sorted.filter(r => r.calibrated).length / sorted.length) * 100;
  if (calibratedPct < gate.minCalibrationPct) {
    throw new Error(
      `CGM calibration coverage ${calibratedPct.toFixed(1)}% is below the ${gate.minCalibrationPct}% minimum.`
    );
  }

  const coverageDays =
    (sorted[sorted.length - 1].ts - sorted[0].ts) / 86_400_000;

  // Glucose statistics for quality scoring
  const values = sorted.map(r => r.glucoseMgDl);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const inRange = values.filter(v => v >= 70 && v <= 180).length / values.length;

  return { readings: sorted, deviceModel, coverageDays, mean, inRange };
}

/**
 * Validate a genomic variant panel.
 *
 * Expected variant shape:
 *   { rsid: string, chromosome: string, position: number,
 *     allele1: string, allele2: string }
 */
function validateGenome(variants, consentCode) {
  const gate = QUALITY_GATE.GENOME_VARIANT;

  if (consentCode !== gate.requiredConsentCode) {
    throw new Error(
      `Genomic data requires explicit consent code '${gate.requiredConsentCode}'. ` +
      `Received: '${consentCode}'. Patient must re-consent specifically for genome research.`
    );
  }
  if (!Array.isArray(variants) || variants.length < gate.minVariants) {
    throw new Error(`Genome panel needs ≥${gate.minVariants} variants (got ${variants?.length ?? 0}).`);
  }

  const t2dVariants = variants.filter(v => T2D_LOCI.has(v.rsid));

  return { variants, totalVariants: variants.length, t2dVariantCount: t2dVariants.length };
}

/**
 * Validate a FreeStyle Libre flash-glucose session log.
 *
 * Expected scan shape:
 *   { ts: number (epoch ms), glucoseMgDl: number, scanType: "flash"|"alarm" }
 */
function validateLibreFlash(scans) {
  const gate = QUALITY_GATE.LIBRE_FLASH;

  if (!Array.isArray(scans) || scans.length < gate.minScans) {
    throw new Error(`Libre flash dataset needs ≥${gate.minScans} scans.`);
  }

  const sorted = [...scans].sort((a, b) => a.ts - b.ts);
  const coverageDays = (sorted[sorted.length - 1].ts - sorted[0].ts) / 86_400_000;

  if (coverageDays < gate.minCoverageDays) {
    throw new Error(
      `Libre session must span ≥${gate.minCoverageDays} days (got ${coverageDays.toFixed(1)}).`
    );
  }

  return { readings: sorted, coverageDays };
}

/**
 * Validate a paired CGM + lifestyle dataset.
 *
 * Expected entry shape:
 *   { ts: number, glucoseMgDl: number, activity?: string,
 *     mealCarbs?: number, sleepMinutes?: number }
 */
function validateLifestyleCorr(entries) {
  const gate = QUALITY_GATE.LIFESTYLE_CORR;

  if (!Array.isArray(entries) || entries.length < gate.minReadings) {
    throw new Error(`Lifestyle correlation dataset needs ≥${gate.minReadings} paired entries.`);
  }

  if (gate.requiresPairedActivity) {
    const withActivity = entries.filter(e => e.activity !== undefined || e.mealCarbs !== undefined).length;
    if (withActivity / entries.length < 0.5) {
      throw new Error("Lifestyle dataset needs ≥50% of entries with activity or meal data.");
    }
  }

  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const coverageDays = (sorted[sorted.length - 1].ts - sorted[0].ts) / 86_400_000;
  return { readings: sorted, coverageDays };
}

/**
 * Validate a routine blood biomarker panel.
 *
 * Expected panel shape (one per blood draw):
 *   { ts: number (epoch ms), hba1c?: number, crp?: number, ldl?: number,
 *     hdl?: number, triglycerides?: number, glucose?: number,
 *     ferritin?: number, wbc?: number, hb?: number, ... }
 *
 * This is the most accessible data source — anyone with a GP visit has one.
 */
function validateBloodBiomarker(panels) {
  const gate = QUALITY_GATE.BLOOD_BIOMARKER;
  if (!Array.isArray(panels) || panels.length < gate.minPanels) {
    throw new Error(`Blood biomarker dataset needs ≥${gate.minPanels} panel(s).`);
  }
  const missing = gate.requiredMarkers.filter(m => !panels.some(p => p[m] != null));
  if (missing.length) {
    throw new Error(`Missing required biomarkers: ${missing.join(", ")}.`);
  }
  const sorted = [...panels].sort((a, b) => a.ts - b.ts);
  const markerCount = new Set(sorted.flatMap(p => Object.keys(p).filter(k => k !== "ts"))).size;
  return { panels: sorted, panelCount: sorted.length, markerCount };
}

/**
 * Validate an immunological panel (antibody titres, cytokines, cell counts).
 *
 * Expected measurement shape:
 *   { ts: number, analyte: string, value: number, unit: string }
 *   e.g. { ts: ..., analyte: "igg", value: 12.4, unit: "g/L" }
 *        { ts: ..., analyte: "il6", value: 3.2,  unit: "pg/mL" }
 *        { ts: ..., analyte: "cd4", value: 650,  unit: "cells/uL" }
 *
 * Useful for: mAb therapy response, vaccine immunogenicity, autoimmune monitoring.
 */
function validateImmunePanel(measurements) {
  const gate = QUALITY_GATE.IMMUNE_PANEL;
  if (!Array.isArray(measurements) || measurements.length < gate.minMeasurements) {
    throw new Error(`Immune panel needs ≥${gate.minMeasurements} measurements.`);
  }
  const analytes = [...new Set(measurements.map(m => m.analyte?.toLowerCase()))].filter(Boolean);
  const missingRequired = gate.requiredAnalytes.filter(a => !analytes.includes(a));
  if (missingRequired.length) {
    throw new Error(`Missing required immune analytes: ${missingRequired.join(", ")}.`);
  }
  const sorted = [...measurements].sort((a, b) => a.ts - b.ts);
  // Group by draw date (day-level bucket) to count distinct panel visits
  const days = new Set(sorted.map(m => new Date(m.ts).toDateString())).size;
  return { panels: sorted, analyteCcount: analytes.length, panelCount: days };
}

// ── Quality scoring ──────────────────────────────────────────────────────────

/**
 * Compute a 0–1 quality score from validated dataset properties.
 *
 * Higher quality → higher payment multiplier in the model oracle.
 */
function computeQualityScore(validated, dataType) {
  switch (dataType) {
    case DatasetType.CGM_TIMESERIES: {
      // 40% coverage (up to 90 days), 30% density, 30% time-in-range
      const coverage = Math.min(validated.coverageDays / 90, 1);
      const density  = Math.min(validated.readings.length / 25_920, 1); // 90d at 5-min
      const tir      = validated.inRange ?? 0;
      return Math.round((coverage * 0.4 + density * 0.3 + tir * 0.3) * 1000) / 1000;
    }
    case DatasetType.GENOME_VARIANT: {
      // 60% T2D loci hit rate, 40% total variant count depth
      const t2dHit = Math.min(validated.t2dVariantCount / T2D_LOCI.size, 1);
      const depth  = Math.min(validated.totalVariants / 500, 1);
      return Math.round((t2dHit * 0.6 + depth * 0.4) * 1000) / 1000;
    }
    case DatasetType.LIBRE_FLASH:
    case DatasetType.LIFESTYLE_CORR: {
      const coverage = Math.min(validated.coverageDays / 30, 1);
      const density  = Math.min(validated.readings.length / 720, 1);
      return Math.round((coverage * 0.5 + density * 0.5) * 1000) / 1000;
    }
    case DatasetType.BLOOD_BIOMARKER: {
      // Quality = marker completeness (all standard markers present)
      const completeness = Math.min(validated.markerCount / 12, 1);
      const longi = Math.min(validated.panelCount / 4, 1); // longitudinal draws
      return Math.round((completeness * 0.6 + longi * 0.4) * 1000) / 1000;
    }
    case DatasetType.IMMUNE_PANEL: {
      const analytes = Math.min(validated.analyteCcount / 20, 1);
      const longi    = Math.min(validated.panelCount / 3, 1);
      return Math.round((analytes * 0.7 + longi * 0.3) * 1000) / 1000;
    }
    default:
      return 0.5;
  }
}

// ── Main tokenizer ───────────────────────────────────────────────────────────

/**
 * Tokenize a clinical dataset.
 *
 * The tokenizer produces a lightweight DatasetToken — never the raw data.
 * Raw data must be stored separately (encrypted, patient-controlled).
 *
 * @param {object} opts
 * @param {string}   opts.dataType       DatasetType constant
 * @param {any[]}    opts.payload        Raw reading/variant array (stays off-chain)
 * @param {string}   opts.consentToken   Opaque consent token from privacyLayer
 * @param {string}   [opts.deviceModel]  Device identifier ("Dexcom G7", "Libre 3", ...)
 * @param {object}   [opts.metadata]     Extra metadata (consentCode for genome, etc.)
 * @returns {DatasetToken}
 */
export function tokenizeDataset({
  dataType,
  payload,
  consentToken,
  deviceModel = "unknown",
  metadata = {},
}) {
  if (!Object.values(DatasetType).includes(dataType)) {
    throw new Error(`Unknown dataset type: ${dataType}`);
  }
  if (!consentToken || typeof consentToken !== "string") {
    throw new Error("consentToken is required");
  }

  let validated;
  switch (dataType) {
    case DatasetType.CGM_TIMESERIES:
      validated = validateCgm(payload, deviceModel);
      break;
    case DatasetType.GENOME_VARIANT:
      validated = validateGenome(payload, metadata.consentCode);
      break;
    case DatasetType.LIBRE_FLASH:
      validated = validateLibreFlash(payload);
      break;
    case DatasetType.LIFESTYLE_CORR:
      validated = validateLifestyleCorr(payload);
      break;
    case DatasetType.BLOOD_BIOMARKER:
      validated = validateBloodBiomarker(payload);
      break;
    case DatasetType.IMMUNE_PANEL:
      validated = validateImmunePanel(payload);
      break;
  }

  // Pseudonymous contributor ID — HMAC of consent token.
  // Cannot be reversed to patient identity; stable per-patient per-market.
  const contributorId = crypto
    .createHmac("sha256", "biomint-pseudonym-salt-v1")
    .update(consentToken)
    .digest("hex")
    .slice(0, 32);

  const dataItems = validated.readings ?? validated.variants ?? validated.panels ?? [];
  const contentHash = merkleRoot(dataItems);

  const tokenId = crypto
    .createHash("sha256")
    .update(`${contentHash}:${contributorId}:${dataType}:${Date.now()}`)
    .digest("hex");

  const qualityScore = computeQualityScore(validated, dataType);

  return {
    tokenId,
    dataType,
    contentHash,
    contributorId,
    deviceModel,
    recordCount: dataItems.length,
    coverageDays:     validated.coverageDays     ?? null,
    t2dVariantCount:  validated.t2dVariantCount  ?? null,
    glucoseMean:      validated.mean             ?? null,
    timeInRange:      validated.inRange          ?? null,
    markerCount:      validated.markerCount      ?? null,
    analyteCcount:    validated.analyteCcount    ?? null,
    qualityScore,
    createdAt: new Date().toISOString(),
    schema: "biomint-v1",
    metadata,
  };
}

// ── Synthetic data generators (for demo / testing) ───────────────────────────

/**
 * Generate a synthetic Dexcom G7 CGM timeseries.
 *
 * Produces realistic glucose patterns including dawn phenomenon,
 * post-meal spikes, and nocturnal stability — without any real patient data.
 *
 * @param {object} opts
 * @param {number}  opts.days              Coverage in days (default 14)
 * @param {number}  [opts.baseGlucose]     Fasting glucose baseline in mg/dL (default 105)
 * @param {string}  [opts.profile]         "controlled" | "labile" | "hyperglycemic"
 * @param {number}  [opts.seed]            Deterministic seed for reproducibility
 * @returns {Array<{ts, glucoseMgDl, calibrated, trend}>}
 */
export function syntheticCgm({
  days = 14,
  baseGlucose = 105,
  profile = "controlled",
  seed = 42,
} = {}) {
  const readings = [];
  const now = Date.now();
  const startTs = now - days * 86_400_000;
  const intervalMs = 5 * 60_000; // 5 minutes
  const count = Math.floor((days * 86_400_000) / intervalMs);

  // Simple PRNG seeded for reproducibility
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };

  const spikeAmplitude = profile === "labile" ? 80 : profile === "hyperglycemic" ? 60 : 40;
  const noiseLevel     = profile === "labile" ? 15 : 8;
  const baselineShift  = profile === "hyperglycemic" ? 40 : 0;

  for (let i = 0; i < count; i++) {
    const ts = startTs + i * intervalMs;
    const hourOfDay = ((ts / 3_600_000) % 24 + 24) % 24;

    // Circadian component: dawn phenomenon 5–8 AM, post-meal spikes at 7/12/18h
    const circadian = Math.sin((hourOfDay - 5) * Math.PI / 12) * 15;
    const mealSpike =
      (Math.exp(-((hourOfDay - 7.5) ** 2) / 2) +
       Math.exp(-((hourOfDay - 12.5) ** 2) / 2) +
       Math.exp(-((hourOfDay - 18.5) ** 2) / 2)) * spikeAmplitude;

    const noise = (rand() - 0.5) * noiseLevel;
    const glucose = Math.max(55, Math.min(350,
      baseGlucose + baselineShift + circadian + mealSpike + noise
    ));

    // Trend: simple derivative from previous
    let trend = "Flat";
    if (i > 0) {
      const prev = readings[i - 1].glucoseMgDl;
      const rate = (glucose - prev) / 5; // mg/dL per minute
      if (rate > 2)       trend = "RisingQuickly";
      else if (rate > 1)  trend = "Rising";
      else if (rate < -2) trend = "FallingQuickly";
      else if (rate < -1) trend = "Falling";
    }

    readings.push({
      ts,
      glucoseMgDl: Math.round(glucose),
      calibrated: rand() > 0.02,  // 98% calibration rate
      trend,
    });
  }

  return readings;
}

/**
 * Generate a synthetic T2D genomic variant panel.
 *
 * Includes all known T2D GWAS loci plus random non-T2D variants.
 *
 * @param {number} totalVariants   Total variants in panel (default 250)
 * @param {number} seed
 * @returns {Array<{rsid, chromosome, position, allele1, allele2, t2dRelevant}>}
 */
export function syntheticGenome(totalVariants = 250, seed = 42) {
  const variants = [];
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };

  const t2dLociArray = [...T2D_LOCI];
  const chromosomes = ["1","2","3","4","5","6","7","8","9","10","11","12","X"];
  const alleles = ["A","C","G","T"];

  // Always include all T2D loci
  for (const rsid of t2dLociArray) {
    variants.push({
      rsid,
      chromosome: chromosomes[Math.floor(rand() * chromosomes.length)],
      position: Math.floor(rand() * 200_000_000) + 1_000_000,
      allele1: alleles[Math.floor(rand() * 4)],
      allele2: alleles[Math.floor(rand() * 4)],
      t2dRelevant: true,
    });
  }

  // Fill remainder with random non-T2D variants
  for (let i = variants.length; i < totalVariants; i++) {
    variants.push({
      rsid: `rs${Math.floor(rand() * 90_000_000) + 10_000_000}`,
      chromosome: chromosomes[Math.floor(rand() * chromosomes.length)],
      position: Math.floor(rand() * 200_000_000) + 1_000_000,
      allele1: alleles[Math.floor(rand() * 4)],
      allele2: alleles[Math.floor(rand() * 4)],
      t2dRelevant: false,
    });
  }

  return variants;
}
