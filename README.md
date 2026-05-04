# Agentic Mint Guard MVP

Autonomous mint policy engine for stablecoin risk control.

This MVP demonstrates:
- continuous risk scoring (volatility, liquidity, oracle divergence, concentration)
- automatic policy actions (`hold`, `tighten`, `pause-and-tighten`, `relax`)
- signed decision attestations (`data/attestations.ndjson`)
- a stress simulation that shows LTV and mint cap changes in real time

## 48-hour Build Plan

### Phase 1 (0-8h): Foundations
- finalize policy state schema (`paused`, `maxLtvBps`, `mintCapUsd`, `version`)
- wire risk input model and score computation
- set hard emergency thresholds and safe defaults

### Phase 2 (8-20h): Agent Core
- implement policy decision engine with deterministic transitions
- implement state registry writes and rollback-safe updates
- add rationale generation suitable for judge review

### Phase 3 (20-32h): Trust Layer
- sign every decision with Ed25519
- store append-only attestation log for replay
- include signer fingerprint for integrity checks

### Phase 4 (32-42h): Demo Layer
- add stress scenarios (oracle attack, volatility spike, liquidity crunch)
- show automatic pause and LTV tightening in terminal output
- snapshot before/after policy state

### Phase 5 (42-48h): Solana Integration Path
- connect `apply_policy` to Anchor program instruction
- source market data from oracle adapters
- enforce mint checks in your stablecoin mint path

## Quick Start

```bash
cd agentic-mint-guard
npm run demo
```

`npm run demo` resets policy state and attestation logs before running scenarios.

If you want cumulative behavior across runs:

```bash
npm run demo:keep
```

Run a single decision step:

```bash
npm run agent:once
```

Run one-shot with a clean reset:

```bash
npm run agent:once:reset
```

## Files

- `src/risk.js`: risk scoring model
- `src/policyEngine.js`: autonomous policy decisions
- `src/registry.js`: state persistence (stand-in for on-chain registry)
- `src/attestation.js`: key management and signed attestations
- `src/demo.js`: stress scenario runner
- `contracts/policy_registry_anchor.rs`: Anchor contract skeleton for migration on-chain

---

## BioMint — Clinical Data Exchange (Extension)

A decentralised micropayment hub for clinical health data built on the same
Solana infrastructure as the Mint Guard policy engine.

### The Problem

Pharmaceutical companies (Eli Lilly, Novo Nordisk, Roche) and AI health
labs need high-quality longitudinal data — CGM glucose records from Dexcom
and FreeStyle Libre users, genomic variant panels with T2D loci — to train
better diabetes models.  Patients generate this data but see none of the
value.  Centralised data brokers take the margin.

### The BioMint Model

```
Patient device          BioMint Market          Pharma / AI buyer
  (Dexcom G7)         ─────────────────────     (Eli Lilly)
  Glucose readings ──▶ tokenize (hash only) ──▶ evaluate dataset
  Consent token    ──▶ list on market       ──▶ score model delta
  Solana pubkey    ◀── micropayment         ◀── x402 payment if delta > threshold
```

**Only useful data earns money.**  If a dataset does not meaningfully improve
the buyer's model (measured as accuracy / RMSE delta vs a threshold), no
payment fires.  Junk data accumulates $0.

The hub never owns any patient data.  Raw readings stay on patient devices.
Only Merkle content hashes and pseudonymous contributor IDs go on-chain.

### Supported Dataset Types

| Type | Device examples | Typical value |
|---|---|---|
| `CGM_TIMESERIES` | Dexcom G7, G6 | $0.02–$0.08 per 14-day batch |
| `LIBRE_FLASH` | FreeStyle Libre 3, 2 | $0.01–$0.04 per session log |
| `GENOME_VARIANT` | Illumina GSA, 23andMe raw | $0.05–$0.22 per panel |
| `LIFESTYLE_CORR` | Paired CGM + Apple Health | $0.02–$0.06 per dataset |

### Model Tasks

Buyers specify which prediction task they are training:

- `T2D_GLUCOSE_PREDICTION` — next-60-min glucose from 3 h of CGM (RMSE)
- `HYPOGLYCEMIA_ALERT` — 30-min hypo risk classifier (AUC)
- `GENOME_T2D_RISK` — polygenic risk score (AUC)
- `DRUG_RESPONSE_TIRZEPATIDE` — Lilly tirzepatide 12-week HbA1c response (AUC)
- `INSULIN_SENSITIVITY` — sensitivity index from CGM + lifestyle (RMSE)
- `MEAL_SPIKE_PHENOTYPING` — post-meal spike phenotype classifier (AUC)

### Quick Start — BioMint Demo

```bash
cd agentic-mint-guard
npm run biomint
```

Output shows:

1. **Tokenization** — 5 synthetic patient datasets (Dexcom CGM, Libre, genome)
2. **Listings** — all datasets listed with ask prices and compatible tasks
3. **Evaluations** — Lilly, DeepMed, and GenoCo evaluate each listing
4. **Payments** — only datasets that moved the model needle get paid
5. **Earnings summary** — per-contributor totals and market-wide stats

To keep state across runs (cumulative payments):

```bash
npm run biomint:keep
```

### Architecture

```
src/
  privacyLayer.js    Consent tokens, PII scrubbing, ZK hash commitments
  clinicalData.js    Dataset tokenization, quality gates, synthetic generators
  modelOracle.js     Improvement scoring, payment formula, simulated evaluation
  dataMarket.js      Listings, queries, settlement, market ledger
  demoClinical.js    End-to-end demo runner

programs/data-market/
  src/lib.rs         Anchor program — DatasetRecord PDA, settle_improvement ix

data/
  market_listings.json   Current listing states
  market_ledger.ndjson   Append-only event log (LIST / EVALUATE / DELIST)
  market_stats.json      Aggregated market statistics
  attestations.ndjson    Ed25519-signed improvement attestations (shared with Mint Guard)
```

### On-Chain Settlement (Anchor Program)

The `data-market` program stores `DatasetRecord` PDAs derived from
`["dataset", contributor_pubkey, content_hash]`.  Settlement requires
**two signers**: the buyer (transfers SOL) and the BioMint oracle
(attests the evaluation delta).  This prevents either party from
fabricating payments.

```rust
pub fn settle_improvement(
    ctx: Context<SettleImprovement>,
    delta_bps: u32,
    payment_lamports: u64,
) -> Result<()>
```

### Privacy Design

- **No PII on-chain** — only SHA-256 Merkle roots of anonymised readings
- **Consent tokens** — HMAC-signed, patient-held, expire in 365 days
- **Pseudonymous IDs** — HMAC(consent_token) → irreversible contributor ID
- **Time-shifted records** — timestamps shifted by deterministic per-patient offset (±12 h) to prevent calendar correlation
- **ZK commitments** — `generateDataCommitment()` produces (commitment, blindingFactor) for selective disclosure without revealing raw data

---

## Judge Demo Script (5 min)

1. Show baseline scenario with `relax` (healthy market).
2. Run volatility spike and show `pause-and-tighten` action.
3. Run oracle divergence attack and show `pause-and-tighten`.
4. Open `data/policy_state.json` to show final policy values.
5. Open `data/attestations.ndjson` and verify decisions are signed and explainable.

## Next Steps

- Replace file registry with Solana account writes.
- Add liquidation-aware debt constraints.
- Add multi-agent quorum before `pause-and-tighten` actions.
