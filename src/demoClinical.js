/**
 * BioMint Clinical Data Exchange — end-to-end demo.
 *
 * Simulates the full market lifecycle:
 *
 *  PATIENTS
 *    Alice  — Dexcom G7 user, 30 days CGM, well-controlled T2D
 *    Bob    — FreeStyle Libre 3 user, 14 days, labile glucose
 *    Carol  — Genome panel (T2D GWAS loci) + paired CGM/lifestyle
 *    David  — Hyperglycemic Dexcom user, 90 days (high value)
 *
 *  BUYERS (pharma / AI)
 *    Lilly   — Evaluating tirzepatide response prediction (DRUG_RESPONSE_TIRZEPATIDE)
 *    DeepMed — General glucose forecasting model (T2D_GLUCOSE_PREDICTION)
 *    GenoCo  — Polygenic risk score model (GENOME_T2D_RISK)
 *
 *  FLOW per buyer:
 *    1. Query the market for compatible listings
 *    2. Evaluate each listing → model oracle scores improvement
 *    3. If delta > threshold AND payment ≥ ask → micropayment fires
 *    4. Show per-listing earnings and market summary
 *
 *  KEY INSIGHT:
 *    Only datasets that demonstrably improve a model get paid.
 *    David's 90-day CGM earns the most; Bob's noisy 14-day record earns less;
 *    Carol's genome panel is uniquely valuable to GenoCo but not to DeepMed.
 */

import crypto from "node:crypto";
import { generateConsentToken, anonymize } from "./privacyLayer.js";
import {
  DatasetType, tokenizeDataset,
  syntheticCgm, syntheticGenome,
} from "./clinicalData.js";
import { ModelTask } from "./modelOracle.js";
import {
  listDataset, queryListings, evaluateAndSettle,
  getMarketStats, resetMarket,
} from "./dataMarket.js";
import { resetAttestations } from "./attestation.js";

// ── Synthetic blood panel generators ─────────────────────────────────────────

/** Generate N blood biomarker panels over the last (N*90) days. */
function syntheticBloodPanels(panelCount = 3, seed = 42) {
  const now = Date.now();
  const panels = [];
  for (let i = 0; i < panelCount; i++) {
    const ts = now - (panelCount - i) * 90 * 86400_000;
    const rng = (offset) => (Math.sin(seed * (i + 1 + offset) * 7919) * 0.5 + 0.5);
    panels.push({
      ts,
      hba1c:        5.5 + rng(1) * 2.0,    // 5.5 – 7.5 %
      crp:          0.5 + rng(2) * 4.0,    // 0.5 – 4.5 mg/L
      ldl:          90  + rng(3) * 60,     // 90 – 150 mg/dL
      hdl:          45  + rng(4) * 25,     // 45 – 70 mg/dL
      triglycerides:100  + rng(5) * 100,   // 100 – 200 mg/dL
      glucose:      85  + rng(6) * 30,     // fasting 85 – 115 mg/dL
      ferritin:     40  + rng(7) * 120,    // 40 – 160 ng/mL
      wbc:          5.5 + rng(8) * 4,      // 5.5 – 9.5 ×10^9/L
      hb:           12  + rng(9) * 3.5,    // 12 – 15.5 g/dL
      alt:          20  + rng(10) * 30,    // 20 – 50 U/L
      creatinine:   0.7 + rng(11) * 0.5,  // 0.7 – 1.2 mg/dL
      vitd:         40  + rng(12) * 50,    // 40 – 90 nmol/L
    });
  }
  return panels;
}

/** Generate an immunological panel series — IgG, IL-6, CD4, CRP, anti-CCP, TNF-alpha. */
function syntheticImmunePanel(monthCount = 12, seed = 99) {
  const now = Date.now();
  const analytes = [
    { name: "igg",     unit: "g/L",       base: 10,   range: 5 },
    { name: "il6",     unit: "pg/mL",     base: 3,    range: 15 },
    { name: "cd4",     unit: "cells/uL",  base: 600,  range: 400 },
    { name: "crp",     unit: "mg/L",      base: 2,    range: 30 },
    { name: "anti_ccp",unit: "U/mL",      base: 5,    range: 200 },
    { name: "tnf",     unit: "pg/mL",     base: 1.5,  range: 20 },
  ];
  const measurements = [];
  for (let m = 0; m < monthCount; m++) {
    const ts = now - (monthCount - m) * 30 * 86400_000;
    for (const a of analytes) {
      const rng = Math.sin(seed * (m + 1) * a.name.length * 1009) * 0.5 + 0.5;
      measurements.push({ ts, analyte: a.name, value: a.base + rng * a.range, unit: a.unit });
    }
  }
  return measurements;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SOL_PER_LAMPORT = 1e-9;
const USD_PER_SOL = 150;      // approx price used for display only

function lamportsToUsd(lamports) {
  return (lamports * SOL_PER_LAMPORT * USD_PER_SOL).toFixed(4);
}

function hr(label = "") {
  const w = 70;
  if (!label) { console.log("─".repeat(w)); return; }
  const pad = Math.max(0, w - label.length - 4);
  console.log(`── ${label} ${"─".repeat(pad)}`);
}

function statusTag(status) {
  return {
    PAID:       "✓ PAID",
    BELOW_ASK:  "↓ BELOW ASK",
    SKIPPED:    "✗ NO IMPROVEMENT",
  }[status] ?? status;
}

// ── Patient setup ────────────────────────────────────────────────────────────

function buildPatient(name, nonce, useCodes) {
  const consent = generateConsentToken(nonce, useCodes, 365);
  return { name, nonce, consent };
}

// Simulated Solana pubkeys (base58-like, not real wallets)
function fakePubkey(seed) {
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 44);
}

// ── Main demo ────────────────────────────────────────────────────────────────

async function main() {
  const keepState = process.argv.includes("--keep-state");

  if (!keepState) {
    resetMarket();
    resetAttestations();
    console.log("Market and attestation logs reset.\n");
  }

  hr("BioMint — Clinical Data Exchange Demo");
  console.log(
    "Decentralised micropayment hub for CGM, genome & lifestyle data.\n" +
    "Only data that provably improves a model earns a payment.\n"
  );

  // ── 1. Patient consent & dataset tokenization ──────────────────────────────

  hr("Step 1 — Patient Consent & Dataset Tokenization");

  const alice = buildPatient("Alice",  crypto.randomBytes(16).toString("hex"), [
    "DIABETES_RESEARCH", "AI_TRAINING",
  ]);
  const bob   = buildPatient("Bob",    crypto.randomBytes(16).toString("hex"), [
    "DIABETES_RESEARCH", "AI_TRAINING",
  ]);
  const carol = buildPatient("Carol",  crypto.randomBytes(16).toString("hex"), [
    "DIABETES_RESEARCH", "GENOME_RESEARCH", "DRUG_DEVELOPMENT", "AI_TRAINING",
  ]);
  const david = buildPatient("David",  crypto.randomBytes(16).toString("hex"), [
    "DIABETES_RESEARCH", "AI_TRAINING", "DRUG_DEVELOPMENT",
  ]);
  const eva   = buildPatient("Eva",    crypto.randomBytes(16).toString("hex"), [
    "AGGREGATED_STATS", "AI_TRAINING", "DRUG_DEVELOPMENT",
  ]);
  const frank = buildPatient("Frank",  crypto.randomBytes(16).toString("hex"), [
    "DRUG_DEVELOPMENT", "AI_TRAINING", "AGGREGATED_STATS",
  ]);

  const patients = [alice, bob, carol, david, eva, frank];

  // Generate synthetic datasets (no real patient data)
  const rawDatasets = {
    alice_cgm:      syntheticCgm({ days: 30, baseGlucose: 110, profile: "controlled",   seed: 101 }),
    bob_libre:      syntheticCgm({ days: 14, baseGlucose: 130, profile: "labile",        seed: 202 }),
    carol_genome:   syntheticGenome(280, 303),
    carol_cgm:      syntheticCgm({ days: 21, baseGlucose: 118, profile: "controlled",   seed: 404 }),
    david_cgm:      syntheticCgm({ days: 90, baseGlucose: 155, profile: "hyperglycemic",seed: 505 }),
    eva_blood:      syntheticBloodPanels(3, 606),   // 3 annual panels
    frank_immune:   syntheticImmunePanel(12, 707),  // 12 monthly draws
  };

  console.log("Generating and anonymizing datasets...\n");

  // Anonymize before tokenizing (PII scrub + time-shift)
  const anonDatasets = {
    alice_cgm:    anonymize(rawDatasets.alice_cgm,    alice.nonce),
    bob_libre:    anonymize(rawDatasets.bob_libre,    bob.nonce),
    carol_genome: anonymize(rawDatasets.carol_genome, carol.nonce),
    carol_cgm:    anonymize(rawDatasets.carol_cgm,    carol.nonce),
    david_cgm:    anonymize(rawDatasets.david_cgm,    david.nonce),
    eva_blood:    anonymize(rawDatasets.eva_blood,    eva.nonce),
    frank_immune: anonymize(rawDatasets.frank_immune, frank.nonce),
  };

  // Tokenize
  let tokens;
  try {
    tokens = {
      alice_cgm: tokenizeDataset({
        dataType: DatasetType.CGM_TIMESERIES,
        payload: anonDatasets.alice_cgm,
        consentToken: alice.consent.token,
        deviceModel: "Dexcom G7",
      }),
      bob_libre: tokenizeDataset({
        dataType: DatasetType.LIBRE_FLASH,
        payload: anonDatasets.bob_libre,
        consentToken: bob.consent.token,
        deviceModel: "FreeStyle Libre 3",
      }),
      carol_genome: tokenizeDataset({
        dataType: DatasetType.GENOME_VARIANT,
        payload: anonDatasets.carol_genome,
        consentToken: carol.consent.token,
        deviceModel: "Illumina GSA",
        metadata: { consentCode: "GENOME_RESEARCH" },
      }),
      carol_cgm: tokenizeDataset({
        dataType: DatasetType.CGM_TIMESERIES,
        payload: anonDatasets.carol_cgm,
        consentToken: carol.consent.token,
        deviceModel: "Dexcom G7",
      }),
      david_cgm: tokenizeDataset({
        dataType: DatasetType.CGM_TIMESERIES,
        payload: anonDatasets.david_cgm,
        consentToken: david.consent.token,
        deviceModel: "Dexcom G7",
      }),
      eva_blood: tokenizeDataset({
        dataType: DatasetType.BLOOD_BIOMARKER,
        payload: anonDatasets.eva_blood,
        consentToken: eva.consent.token,
        deviceModel: "Lab (Roche Cobas)",
      }),
      frank_immune: tokenizeDataset({
        dataType: DatasetType.IMMUNE_PANEL,
        payload: anonDatasets.frank_immune,
        consentToken: frank.consent.token,
        deviceModel: "Luminex MAGPIX",
      }),
    };
  } catch (err) {
    console.error("Tokenization failed:", err.message);
    process.exit(1);
  }

  for (const [key, tok] of Object.entries(tokens)) {
    const owner = key.split("_")[0];
    console.log(
      `  ${owner.padEnd(6)} ${tok.dataType.padEnd(18)}` +
      `  records=${String(tok.recordCount).padStart(5)}` +
      `  quality=${tok.qualityScore.toFixed(3)}` +
      (tok.coverageDays   ? `  coverage=${tok.coverageDays.toFixed(1)}d` : "") +
      (tok.t2dVariantCount ? `  t2dLoci=${tok.t2dVariantCount}` : "")
    );
  }

  // ── 2. List datasets on market ─────────────────────────────────────────────

  hr("Step 2 — Listing Datasets on BioMint Market");

  const pubkeys = {
    alice: fakePubkey("alice-wallet"),
    bob:   fakePubkey("bob-wallet"),
    carol: fakePubkey("carol-wallet"),
    david: fakePubkey("david-wallet"),
    eva:   fakePubkey("eva-wallet"),
    frank: fakePubkey("frank-wallet"),
  };

  const listings = {
    alice_cgm:    listDataset(tokens.alice_cgm,     50_000, pubkeys.alice),
    bob_libre:    listDataset(tokens.bob_libre,      40_000, pubkeys.bob),
    carol_genome: listDataset(tokens.carol_genome,  200_000, pubkeys.carol),
    carol_cgm:    listDataset(tokens.carol_cgm,      50_000, pubkeys.carol),
    david_cgm:    listDataset(tokens.david_cgm,      80_000, pubkeys.david),
    eva_blood:    listDataset(tokens.eva_blood,      60_000, pubkeys.eva),
    frank_immune: listDataset(tokens.frank_immune,  150_000, pubkeys.frank),
  };

  console.log("\nActive listings:\n");
  console.log(
    `  ${"ListingID".padEnd(26)} ${"Type".padEnd(18)} ${"Quality".padEnd(9)} ${"Ask (SOL)".padEnd(12)} Compatible tasks`
  );
  console.log("  " + "─".repeat(100));
  for (const [key, l] of Object.entries(listings)) {
    console.log(
      `  ${l.listingId.slice(0, 24).padEnd(26)} ` +
      `${l.dataType.padEnd(18)} ` +
      `${l.qualityScore.toFixed(3).padEnd(9)} ` +
      `${(l.askLamports * SOL_PER_LAMPORT).toFixed(7).padEnd(12)} ` +
      l.compatibleTasks.join(", ")
    );
  }

  // ── 3. Buyers evaluate datasets ────────────────────────────────────────────

  hr("Step 3 — Buyer Evaluations & Micropayment Settlement");

  const buyers = [
    {
      name: "Eli Lilly",
      pubkey: fakePubkey("lilly-wallet"),
      tasks: [ModelTask.DRUG_RESPONSE_TIRZEPATIDE, ModelTask.T2D_GLUCOSE_PREDICTION],
      mission: "Tirzepatide response prediction & glucose modelling",
    },
    {
      name: "DeepMed AI",
      pubkey: fakePubkey("deepmed-wallet"),
      tasks: [ModelTask.T2D_GLUCOSE_PREDICTION, ModelTask.HYPOGLYCEMIA_ALERT],
      mission: "Next-hour glucose forecasting & hypo alert systems",
    },
    {
      name: "GenoCo Research",
      pubkey: fakePubkey("genoco-wallet"),
      tasks: [ModelTask.GENOME_T2D_RISK, ModelTask.DRUG_RESPONSE_TIRZEPATIDE],
      mission: "T2D polygenic risk scoring & pharmacogenomics",
    },
    {
      name: "AstraZeneca",
      pubkey: fakePubkey("az-wallet"),
      tasks: [ModelTask.ANTIBODY_RESPONSE, ModelTask.AUTOIMMUNE_RISK],
      mission: "mAb therapy response & autoimmune disease stratification",
    },
    {
      name: "InfLab",
      pubkey: fakePubkey("inflab-wallet"),
      tasks: [ModelTask.INFLAMMATION_TRAJECTORY, ModelTask.ANTIBODY_RESPONSE],
      mission: "Chronic inflammation trajectory & CRP/IL-6 forecasting",
    },
  ];

  const allSettlements = [];

  for (const buyer of buyers) {
    console.log(`\n  Buyer: ${buyer.name} — ${buyer.mission}`);
    console.log(`  Tasks: ${buyer.tasks.join(", ")}\n`);

    for (const task of buyer.tasks) {
      const compatListings = queryListings({ compatibleTask: task });
      if (compatListings.length === 0) {
        console.log(`    [${task}] No compatible listings found.`);
        continue;
      }

      for (const listing of compatListings) {
        const s = await evaluateAndSettle(
          listing.listingId, task, buyer.pubkey, buyer.name
        );
        allSettlements.push(s);

        const payStr = s.paymentStatus === "PAID"
          ? `${(s.paymentLamports * SOL_PER_LAMPORT).toFixed(7)} SOL (~$${lamportsToUsd(s.paymentLamports)})`
          : "–";

        console.log(
          `    [${task.slice(0, 28).padEnd(28)}] ` +
          `${listing.dataType.padEnd(18)} ` +
          `Δ=${s.score.delta.toFixed(5).padStart(8)}  ` +
          `${statusTag(s.paymentStatus).padEnd(18)} ` +
          payStr
        );
      }
    }
  }

  // ── 4. Contributor earnings summary ────────────────────────────────────────

  hr("Step 4 — Contributor Earnings (Micropayments Received)");

  const earnings = {};
  for (const s of allSettlements) {
    if (s.paymentStatus === "PAID") {
      earnings[s.tokenId] = (earnings[s.tokenId] ?? 0) + s.paymentLamports;
    }
  }

  const allListings = queryListings({ status: undefined });  // all statuses
  console.log();
  console.log(
    `  ${"Owner".padEnd(8)} ${"Dataset".padEnd(20)} ${"Evals".padEnd(7)} ${"Paid".padEnd(7)} ${"Total SOL".padEnd(14)} Total USD`
  );
  console.log("  " + "─".repeat(80));

  const ownerMap = {
    [listings.alice_cgm.listingId]:    "Alice",
    [listings.bob_libre.listingId]:    "Bob",
    [listings.carol_genome.listingId]: "Carol",
    [listings.carol_cgm.listingId]:    "Carol",
    [listings.david_cgm.listingId]:    "David",
    [listings.eva_blood.listingId]:    "Eva",
    [listings.frank_immune.listingId]: "Frank",
  };

  let grandTotal = 0;
  for (const l of allListings) {
    const owner = ownerMap[l.listingId] ?? "?";
    const totalLamps = l.totalLamportsReceived;
    grandTotal += totalLamps;
    console.log(
      `  ${owner.padEnd(8)} ` +
      `${l.dataType.padEnd(20)} ` +
      `${String(l.evaluationCount).padEnd(7)} ` +
      `${String(l.improvementCount).padEnd(7)} ` +
      `${(totalLamps * SOL_PER_LAMPORT).toFixed(7).padEnd(14)} ` +
      `$${lamportsToUsd(totalLamps)}`
    );
  }

  console.log("  " + "─".repeat(80));
  console.log(
    `  ${"TOTAL".padEnd(8)} ${"".padEnd(20)} ${"".padEnd(7)} ${"".padEnd(7)} ` +
    `${(grandTotal * SOL_PER_LAMPORT).toFixed(7).padEnd(14)} $${lamportsToUsd(grandTotal)}`
  );

  // ── 5. Market health snapshot ──────────────────────────────────────────────

  hr("Step 5 — Market Statistics");
  const stats = getMarketStats();
  const payRate = stats.totalEvaluations > 0
    ? ((stats.totalPaymentsMade / stats.totalEvaluations) * 100).toFixed(1)
    : "0.0";

  console.log(`
  Listings          : ${stats.totalListings}
  Total evaluations : ${stats.totalEvaluations}
  Payments made     : ${stats.totalPaymentsMade}  (${payRate}% of evals)
  Total SOL paid    : ${(stats.totalLamportsPaid * SOL_PER_LAMPORT).toFixed(7)} SOL
  Total USD paid    : $${lamportsToUsd(stats.totalLamportsPaid)}

  By data type:
${Object.entries(stats.byDataType)
    .map(([t, n]) => `    ${t.padEnd(18)} : ${n} listing(s)`)
    .join("\n")}
  `);

  hr("Key Insight");
  console.log(`
  Only ${payRate}% of evaluations triggered payment — the market is selective.
  Long-duration Dexcom records (David, 90 days) earned the most; short
  noisy records earned less.  Carol's genome panel was uniquely valuable
  to GenoCo's pharmacogenomics model but irrelevant to DeepMed's CGM model.

  The BioMint hub never owns the data.  Patients hold their consent tokens;
  raw readings stay on their devices.  Only content hashes and pseudonymous
  contributor IDs go on-chain.  Payments are fully traceable in:

    data/attestations.ndjson   — signed improvement attestations
    data/market_ledger.ndjson  — full event log (LIST / EVALUATE / DELIST)
    data/market_listings.json  — current listing states
  `);
}

main().catch(err => {
  console.error("Demo error:", err);
  process.exit(1);
});
