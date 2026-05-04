/**
 * Live oracle adapter — fetches real market data from:
 *   • Jupiter swap/v1/quote  (primary price for SOL — swap quote, not deprecated price API)
 *   • Pyth Hermes v2         (secondary price — oracle divergence signal)
 *   • DexScreener            (liquidity depth + 24-h volatility proxy)
 *   • CoinGecko              (tertiary fallback price when both Jupiter and Pyth fail)
 *
 * Fallback priority for oraclePriceA:
 *   1. Jupiter swap/v1/quote  ← primary (swap route)
 *   2. Pyth Hermes v2         ← same value used for B (no artificial divergence)
 *   3. CoinGecko simple price ← tertiary
 *   4. Last known good        ← emergency cache (only if all live sources fail)
 *
 * Returns the same shape expected by computeRisk() and policyEngine.js.
 * On any network failure the previous result (or a safe static fallback)
 * is returned so the policy loop never crashes.
 */

// Well-known addresses
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// SOL/USD price feed ID (without 0x prefix) for Pyth Hermes
const PYTH_SOL_USD_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Jupiter v1 swap API — use swap/v1/quote (price/v2 is dead as of 2026)
const JUPITER_SWAP_API = "https://api.jup.ag/swap/v1";

// Last known good values — avoids hard failure on transient API errors
let _lastGood = null;

// ── Fetchers ──────────────────────────────────────────────────────────────────

/**
 * Primary: derive SOL/USD from a 1-SOL → USDC swap quote.
 * This is more reliable than the deprecated price/v2 endpoint.
 */
async function fetchJupiterPrice() {
  const url =
    `${JUPITER_SWAP_API}/quote` +
    `?inputMint=${SOL_MINT}` +
    `&outputMint=${USDC_MINT}` +
    `&amount=1000000000` + // 1 SOL in lamports
    `&slippageBps=50`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Jupiter ${res.status}`);
  const body = await res.json();
  // outAmount is micro-USDC (6 decimals) → USD
  const microUsdc = parseInt(body.outAmount ?? 0);
  if (!microUsdc) throw new Error("Jupiter: outAmount missing");
  return microUsdc / 1e6;
}

/**
 * Tertiary fallback: CoinGecko simple price API (no auth required).
 */
async function fetchCoinGeckoPrice() {
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const body = await res.json();
  const price = body?.solana?.usd;
  if (!price) throw new Error("CoinGecko: price missing");
  return price;
}

async function fetchPythPrice() {
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SOL_USD_ID}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Pyth ${res.status}`);
  const body = await res.json();
  const parsed = body.parsed?.[0]?.price;
  if (!parsed) throw new Error("Pyth: parsed price missing");
  const price = parseInt(parsed.price) * Math.pow(10, parsed.expo);
  if (!price) throw new Error("Pyth: price is zero");
  return price;
}

async function fetchDexScreener() {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const body = await res.json();

  // Find largest SOL/USDC pool
  const pairs = (body.pairs ?? []).filter(
    (p) =>
      p.chainId === "solana" &&
      (p.quoteToken?.symbol === "USDC" || p.quoteToken?.symbol === "USDT")
  );
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const top = pairs[0];
  if (!top) throw new Error("DexScreener: no SOL/USDC pair found");

  const liquidityDepthUsd = top.liquidity?.usd ?? 200000;
  // priceChange.h24 is a percentage string like "3.21" → ratio
  const h24PctChange = parseFloat(top.priceChange?.h24 ?? 0);
  const volatility24h = Math.abs(h24PctChange) / 100;

  return { liquidityDepthUsd, volatility24h };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch live market data.  Returns a safe static fallback on error.
 * @param {string} [_token]  Placeholder — currently always SOL/USDC
 */
export async function fetchMarketInput(_token = "SOL") {
  const errors = [];

  // Run all four fetches concurrently; capture individual failures
  const [jupResult, pythResult, dexResult, geckoResult] = await Promise.allSettled([
    fetchJupiterPrice(),
    fetchPythPrice(),
    fetchDexScreener(),
    fetchCoinGeckoPrice()
  ]);

  // Pyth price (secondary — used for oracle divergence + fallback for A)
  let oraclePriceB = _lastGood?.oraclePriceB ?? null;
  if (pythResult.status === "fulfilled") {
    oraclePriceB = pythResult.value;
  } else {
    errors.push(`Pyth: ${pythResult.reason?.message}`);
  }

  // Jupiter price (primary): fallback chain → Pyth → CoinGecko → last good
  // IMPORTANT: never fall back to a stale hardcoded value — that causes
  // false oracle-divergence alarms when A≠B. Use the freshest live source.
  let oraclePriceA;
  let sourceLabelA;
  if (jupResult.status === "fulfilled") {
    oraclePriceA = jupResult.value;
    sourceLabelA = "Jupiter";
  } else {
    errors.push(`Jupiter: ${jupResult.reason?.message}`);
    if (oraclePriceB !== null) {
      // Use Pyth as A so no artificial divergence is introduced
      oraclePriceA = oraclePriceB;
      sourceLabelA = "Pyth(fallback)";
    } else if (geckoResult.status === "fulfilled") {
      oraclePriceA = geckoResult.value;
      sourceLabelA = "CoinGecko(fallback)";
    } else {
      oraclePriceA = _lastGood?.oraclePriceA ?? 100;
      sourceLabelA = "cache";
      errors.push(`CoinGecko: ${geckoResult.reason?.message}`);
    }
  }

  // If Pyth also failed, mirror A so divergence stays zero
  if (oraclePriceB === null) {
    oraclePriceB = oraclePriceA;
  }

  // DexScreener: liquidity + volatility
  let liquidityDepthUsd = _lastGood?.liquidityDepthUsd ?? 300000;
  let volatility24h = _lastGood?.volatility24h ?? 0.08;
  if (dexResult.status === "fulfilled") {
    liquidityDepthUsd = dexResult.value.liquidityDepthUsd;
    volatility24h = dexResult.value.volatility24h;
  } else {
    errors.push(`DexScreener: ${dexResult.reason?.message}`);
  }

  // topHolderShare: would need on-chain getTokenLargestAccounts query.
  // Using a conservative static value for now.
  const topHolderShare = 0.38;

  const result = {
    volatility24h,
    liquidityDepthUsd,
    oraclePriceA,
    oraclePriceB,
    topHolderShare,
    fetchedAt: new Date().toISOString(),
    _meta: {
      errors: errors.length ? errors : null,
      sources: {
        oraclePriceA: sourceLabelA,
        oraclePriceB: pythResult.status === "fulfilled" ? "Pyth" : "fallback",
        liquidity: dexResult.status === "fulfilled" ? "DexScreener" : "fallback"
      }
    }
  };

  _lastGood = result;
  return result;
}
