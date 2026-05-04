/**
 * BioMint data market — listing, discovery, evaluation, and micropayment settlement.
 *
 * Lifecycle:
 *   1. Patient tokenizes dataset (clinicalData.js) → DatasetToken
 *   2. listDataset()          → LISTED on market, ask price set
 *   3. Buyer calls evaluateAndSettle() with desired ModelTask
 *        → model oracle scores improvement delta
 *        → if delta > threshold AND payment ≥ ask → x402 micropayment fires
 *        → signed attestation logged to attestations.ndjson
 *   4. Only datasets that demonstrably improved a model accumulate payments.
 *      Low-delta datasets remain listed but earn $0.
 *
 * Persistence: append-only NDJSON market ledger + JSON listings state.
 * On-chain: DatasetRecord PDA via the data-market Anchor program.
 *
 * x402 integration:
 *   In production, evaluateAndSettle() calls x402Facilitator.facilitatePayment()
 *   with a pre-signed buyer transaction.  In demo mode it logs a simulated txid.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { scoreImprovement, simulateModelEvaluation, compatibleTasks } from "./modelOracle.js";
import { signDecision } from "./attestation.js";

// ── Oracle agent config ───────────────────────────────────────────────────────

const ORACLE_PORT = parseInt(process.env.ORACLE_PORT ?? "3100");
const ORACLE_BASE  = `http://127.0.0.1:${ORACLE_PORT}`;

/**
 * Fetch the oracle agent's public key (fingerprint) once and cache it.
 * Used to verify that evaluation signatures come from the real agent process.
 */
let _oraclePubkey = null;
async function getOraclePubkey() {
  if (_oraclePubkey) return _oraclePubkey;
  try {
    const res  = await fetch(`${ORACLE_BASE}/pubkey`);
    const data = await res.json();
    _oraclePubkey = data.oraclePubkey;
    return _oraclePubkey;
  } catch {
    return null;
  }
}

/**
 * Call the oracle agent to evaluate a dataset.
 * Returns { result, score, oracleSignature, oraclePubkey } or throws if
 * the agent is unreachable or the signature cannot be verified.
 *
 * Falls back to in-process simulation ONLY in test / demo mode
 * (ORACLE_FALLBACK=1).  In that case paymentStatus is capped at SIMULATED
 * to make clear no verified oracle was involved.
 */
async function callOracleAgent(listing, modelTask) {
  try {
    const res = await fetch(`${ORACLE_BASE}/evaluate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tokenId:      listing.tokenId,
        dataType:     listing.dataType,
        qualityScore: listing.qualityScore,
        coverageDays: listing.coverageDays ?? null,
        modelTask,
      }),
    });
    if (!res.ok) throw new Error(`Oracle agent returned ${res.status}`);
    return await res.json();
  } catch (err) {
    if (process.env.ORACLE_FALLBACK === "1") {
      // Demo/test fallback — evaluation is NOT agent-verified
      const evaluation = simulateModelEvaluation(
        { tokenId: listing.tokenId, qualityScore: listing.qualityScore, coverageDays: listing.coverageDays },
        modelTask
      );
      const score = scoreImprovement({
        tokenId: listing.tokenId, dataType: listing.dataType, modelTask,
        baselineMetric: evaluation.baselineMetric, newMetric: evaluation.newMetric,
        higherIsBetter: evaluation.higherIsBetter,
        qualityScore: listing.qualityScore, coverageDays: listing.coverageDays,
      });
      return { result: { ...evaluation, delta: score.delta, worthPaying: score.worthPaying }, score,
               oracleSignature: null, oraclePubkey: null, agentVersion: "local-fallback" };
    }
    throw new Error(`Oracle agent unreachable: ${err.message}`);
  }
}

// ── Persistence paths ────────────────────────────────────────────────────────

const LEDGER_PATH  = path.resolve(new URL("market_ledger.ndjson",  CONFIG.dataDir).pathname);
const LISTING_PATH = path.resolve(new URL("market_listings.json", CONFIG.dataDir).pathname);
const STATS_PATH   = path.resolve(new URL("market_stats.json",    CONFIG.dataDir).pathname);

// ── Persistence helpers ──────────────────────────────────────────────────────

function loadListings() {
  try {
    return JSON.parse(fs.readFileSync(LISTING_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveListings(listings) {
  fs.mkdirSync(path.dirname(LISTING_PATH), { recursive: true });
  fs.writeFileSync(LISTING_PATH, JSON.stringify(listings, null, 2));
}

function appendLedger(entry) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify({ ...entry, _ts: Date.now() }) + "\n");
}

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
  } catch {
    return {
      totalListings: 0,
      totalEvaluations: 0,
      totalPaymentsMade: 0,
      totalLamportsPaid: 0,
      uniqueContributors: 0,
      byDataType: {},
    };
  }
}

function saveStats(stats) {
  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
}

function updateStats(delta) {
  const stats = loadStats();
  for (const [k, v] of Object.entries(delta)) {
    if (typeof v === "number") stats[k] = (stats[k] ?? 0) + v;
    else if (typeof v === "object") {
      stats[k] = stats[k] ?? {};
      for (const [sk, sv] of Object.entries(v)) {
        stats[k][sk] = (stats[k][sk] ?? 0) + sv;
      }
    }
  }
  saveStats(stats);
}

// ── Market operations ────────────────────────────────────────────────────────

/**
 * List a tokenized dataset on the BioMint market.
 *
 * @param {object} datasetToken        From tokenizeDataset()
 * @param {number} askLamports         Minimum acceptable payment per evaluation
 * @param {string} contributorPubkey   Solana pubkey — receives micropayments
 * @param {string[]} [taskOverride]    Explicit compatible tasks (defaults to auto-detected)
 * @returns {Listing}
 */
export function listDataset(datasetToken, askLamports, contributorPubkey, taskOverride) {
  if (!datasetToken?.tokenId) throw new Error("Invalid dataset token");
  if (!askLamports || askLamports <= 0) throw new Error("askLamports must be > 0");
  if (!contributorPubkey || typeof contributorPubkey !== "string") {
    throw new Error("contributorPubkey is required");
  }

  const listings = loadListings();

  // Prevent double-listing the same token
  const duplicate = Object.values(listings).find(l => l.tokenId === datasetToken.tokenId);
  if (duplicate) throw new Error(`Token ${datasetToken.tokenId} is already listed as ${duplicate.listingId}`);

  const listingId = crypto
    .createHash("sha256")
    .update(`${datasetToken.tokenId}:${contributorPubkey}:${Date.now()}`)
    .digest("hex")
    .slice(0, 24);

  const tasks = taskOverride ?? compatibleTasks(datasetToken.dataType);

  const listing = {
    listingId,
    tokenId: datasetToken.tokenId,
    dataType: datasetToken.dataType,
    contentHash: datasetToken.contentHash,
    contributorId: datasetToken.contributorId,   // pseudonymous — no PII
    contributorPubkey,
    deviceModel: datasetToken.deviceModel,
    qualityScore: datasetToken.qualityScore,
    recordCount: datasetToken.recordCount,
    coverageDays: datasetToken.coverageDays,
    t2dVariantCount: datasetToken.t2dVariantCount,
    askLamports,
    compatibleTasks: tasks,
    status: "LISTED",
    listedAt: new Date().toISOString(),
    totalLamportsReceived: 0,
    evaluationCount: 0,
    improvementCount: 0,
    noImprovementCount: 0,
  };

  listings[listingId] = listing;
  saveListings(listings);
  appendLedger({ event: "LIST", listingId, dataType: datasetToken.dataType, askLamports });

  updateStats({
    totalListings: 1,
    byDataType: { [datasetToken.dataType]: 1 },
  });

  return listing;
}

/**
 * Query available listings with optional filters.
 *
 * @param {object} [opts]
 * @param {string}   [opts.dataType]       Filter by DatasetType
 * @param {number}   [opts.minQuality]     Minimum quality score (0–1)
 * @param {string}   [opts.compatibleTask] Filter by compatible ModelTask
 * @param {number}   [opts.minCoverageDays] Minimum CGM coverage days
 * @param {string}   [opts.status]         Default "LISTED"
 * @returns {Listing[]}
 */
export function queryListings({
  dataType,
  minQuality,
  compatibleTask,
  minCoverageDays,
  status = "LISTED",
} = {}) {
  const listings = loadListings();
  return Object.values(listings).filter(l => {
    if (status && l.status !== status) return false;
    if (dataType && l.dataType !== dataType) return false;
    if (minQuality != null && l.qualityScore < minQuality) return false;
    if (minCoverageDays != null && (l.coverageDays ?? 0) < minCoverageDays) return false;
    if (compatibleTask && !l.compatibleTasks.includes(compatibleTask)) return false;
    return true;
  });
}

/**
 * Evaluate a listed dataset for model improvement and settle payment if earned.
 *
 * The buyer provides (or we simulate) model metrics before and after training on
 * this dataset.  If improvement exceeds threshold and payment ≥ ask price, the
 * micropayment is executed and an attestation is signed.
 *
 * @param {string} listingId          Target listing
 * @param {string} modelTask          ModelTask constant
 * @param {string} buyerPubkey        Buyer's Solana pubkey
 * @param {string} buyerName          Human-readable buyer name (for logs)
 * @param {object} [evalOverride]     { baselineMetric, newMetric, higherIsBetter } — skip simulation
 * @returns {Promise<Settlement>}
 */
export async function evaluateAndSettle(
  listingId,
  modelTask,
  buyerPubkey,
  buyerName = "unknown",
  evalOverride = null
) {
  const listings = loadListings();
  const listing = listings[listingId];

  if (!listing) throw new Error(`Listing ${listingId} not found`);
  if (listing.status !== "LISTED") throw new Error(`Listing ${listingId} is ${listing.status}`);
  if (!listing.compatibleTasks.includes(modelTask)) {
    throw new Error(
      `Dataset type ${listing.dataType} is not compatible with task ${modelTask}. ` +
      `Compatible tasks: ${listing.compatibleTasks.join(", ")}`
    );
  }

  // ── Step 1: call the oracle agent for a signed evaluation ─────────────────
  const agentResponse = await callOracleAgent(listing, modelTask);
  const { result: oracleResult, score, oracleSignature, oraclePubkey, agentVersion } = agentResponse;

  // ── Step 2: verify the oracle signature (skip for local-fallback) ──────────
  //
  // We re-derive the signed payload from the oracle's own fields and check
  // the Ed25519 signature against the oracle public key published at /pubkey.
  // A market server that doesn't call the agent, or tampers with the delta,
  // cannot forge a valid signature without the oracle's private key.
  let signatureVerified = false;
  if (oracleSignature && oraclePubkey) {
    try {
      const pubkeyPem = fs.readFileSync(
        path.resolve(fileURLToPath(new URL("../data/keys/oracle_public.pem", import.meta.url)))
      );
      const signedPayload = JSON.stringify(
        Object.keys(oracleResult).sort().reduce((acc, k) => { acc[k] = oracleResult[k]; return acc; }, {})
      );
      signatureVerified = crypto.verify(
        null,
        Buffer.from(signedPayload),
        pubkeyPem,
        Buffer.from(oracleSignature, "base64")
      );
    } catch {
      signatureVerified = false;
    }
    if (!signatureVerified) {
      throw new Error(
        `Oracle signature verification failed for listing ${listingId} task ${modelTask}. ` +
        `Payment blocked — possible tampering.`
      );
    }
  }

  listing.evaluationCount++;
  updateStats({ totalEvaluations: 1 });

  const settlement = {
    listingId,
    tokenId: listing.tokenId,
    dataType: listing.dataType,
    buyerPubkey,
    buyerName,
    modelTask,
    evaluation: oracleResult,
    score,
    oracleSignature,
    oraclePubkey,
    agentVersion,
    signatureVerified,
    paymentStatus: "SKIPPED",
    paymentLamports: 0,
    txid: null,
    settledAt: new Date().toISOString(),
  };

  if (score.worthPaying && score.paymentLamports >= listing.askLamports) {
    // ── Micropayment settlement ──
    // In production: call x402Facilitator.facilitatePayment({ signedTransactionB64, ... })
    // The buyer's signed Solana transaction transfers SOL from buyer → contributor.
    // Here we log a simulated transaction ID with "sim_" prefix for demo.
    // Payment requires a verified oracle signature.  Without it (local-fallback
    // mode) the status becomes SIMULATED so it's clear no agent was involved.
    const verifiedPayment = signatureVerified || agentVersion === "local-fallback";

    if (!verifiedPayment) {
      settlement.paymentStatus = "UNVERIFIED";
    } else {
    const txid = `sim_${crypto.randomBytes(20).toString("hex")}`;

    settlement.paymentStatus = signatureVerified ? "PAID" : "SIMULATED";
    settlement.paymentLamports = score.paymentLamports;
    settlement.txid = txid;

    listing.totalLamportsReceived += score.paymentLamports;
    listing.improvementCount++;

    updateStats({
      totalPaymentsMade: 1,
      totalLamportsPaid: score.paymentLamports,
    });

    // Sign and append attestation — includes oracle pubkey so it's auditable
    signDecision({
      type:               "BIOMINT_DATA_PAYMENT",
      listingId,
      tokenId:            listing.tokenId,
      dataType:           listing.dataType,
      contentHash:        listing.contentHash,
      contributorId:      listing.contributorId,
      contributorPubkey:  listing.contributorPubkey,
      buyerPubkey,
      buyerName,
      modelTask,
      metric:             score.metric,
      delta:              score.delta,
      paymentLamports:    score.paymentLamports,
      txid,
      oraclePubkey,
      signatureVerified,
      agentVersion,
    });
    }

  } else if (score.worthPaying) {
    // Model improved but offer was below the contributor's ask price
    settlement.paymentStatus = "BELOW_ASK";
    settlement.offeredLamports = score.paymentLamports;
    listing.noImprovementCount++;
  } else {
    // No meaningful improvement — dataset not useful for this task right now
    listing.noImprovementCount++;
  }

  saveListings(listings);
  appendLedger({ event: "EVALUATE", ...settlement });

  return settlement;
}

/**
 * Delist a dataset (contributor withdraws from market).
 *
 * @param {string} listingId
 * @param {string} contributorPubkey   Must match the listing owner
 * @returns {Listing}
 */
export function delistDataset(listingId, contributorPubkey) {
  const listings = loadListings();
  const listing = listings[listingId];
  if (!listing) throw new Error(`Listing ${listingId} not found`);
  if (listing.contributorPubkey !== contributorPubkey) {
    throw new Error("Only the contributing pubkey can delist this dataset");
  }
  listing.status = "DELISTED";
  listing.delistedAt = new Date().toISOString();
  saveListings(listings);
  appendLedger({ event: "DELIST", listingId, contributorPubkey });
  return listing;
}

/**
 * Return current market statistics.
 *
 * @returns {MarketStats}
 */
export function getMarketStats() {
  return loadStats();
}

/**
 * Get a single listing by ID.
 *
 * @param {string} listingId
 * @returns {Listing|null}
 */
export function getListing(listingId) {
  const listings = loadListings();
  return listings[listingId] ?? null;
}

/**
 * Reset market state (for demo / testing).
 */
export function resetMarket() {
  fs.mkdirSync(path.dirname(LISTING_PATH), { recursive: true });
  fs.writeFileSync(LISTING_PATH, "{}");
  fs.writeFileSync(LEDGER_PATH, "");
  fs.writeFileSync(STATS_PATH, JSON.stringify({
    totalListings: 0, totalEvaluations: 0,
    totalPaymentsMade: 0, totalLamportsPaid: 0,
    uniqueContributors: 0, byDataType: {},
  }, null, 2));
}
