/**
 * Jupiter swap executor — converts policy actions into real Solana trades.
 *
 * When the policy engine says "tighten" or "pause-and-tighten", this module:
 *   1. Fetches a swap quote from Jupiter v6 API
 *   2. Gets the swap transaction from Jupiter
 *   3. Signs + sends it to Solana
 *
 * Required env vars (same as onchain.js):
 *   ADMIN_KEYPAIR_JSON      64-byte keypair JSON array
 *   SOLANA_RPC_URL          RPC endpoint (default: devnet)
 *
 * Without ADMIN_KEYPAIR_JSON the function returns { skipped: true }.
 * On devnet SOL→USDC swaps may fail if the pool has no liquidity — the
 * function catches this and returns { error } so the policy loop continues.
 *
 * Token mints:
 *   SOL  = So11111111111111111111111111111111111111112  (wrapped SOL)
 *   USDC = EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (mainnet)
 *   USDC = Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr (devnet USDC-dev)
 */

import {
  Connection,
  Keypair,
  VersionedTransaction
} from "@solana/web3.js";

const JUPITER_SWAP_API = "https://api.jup.ag/swap/v1";

// Token mints — detect devnet vs mainnet from RPC URL
const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC_MAINNET: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDC_DEVNET: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
  USDT_MAINNET: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
};

function isDevnet(rpcUrl) {
  return rpcUrl.includes("devnet");
}

/**
 * Map a policy action to a swap intent.
 *   tighten/pause-and-tighten  → sell SOL, buy USDC (de-risk)
 *   relax/resume               → sell USDC, buy SOL  (re-risk)
 *   hold/deny/failover-block   → no swap
 */
export function swapIntentForAction(action) {
  if (action === "tighten" || action === "pause-and-tighten") {
    return { inputMint: "SOL", outputMint: "USDC", direction: "de-risk" };
  }
  if (action === "relax" || action === "resume") {
    return { inputMint: "USDC", outputMint: "SOL", direction: "re-risk" };
  }
  return null;
}

/**
 * Execute a swap on Jupiter.
 *
 * @param {object} opts
 * @param {string} opts.action          Policy action
 * @param {number} opts.amountUsd       Notional USD to swap (converted to lamports/atoms)
 * @param {number} opts.oraclePriceA    SOL price in USD (for lamport conversion)
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function executeSwap(opts = {}) {
  const {
    action,
    amountUsd = 1000,
    oraclePriceA = 150,
    rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    adminKeypairJson = process.env.ADMIN_KEYPAIR_JSON,
    slippageBps = 50
  } = opts;

  const intent = swapIntentForAction(action);
  if (!intent) {
    return { skipped: true, reason: `no swap needed for action=${action}` };
  }

  if (!adminKeypairJson) {
    return { skipped: true, reason: "ADMIN_KEYPAIR_JSON not set" };
  }

  let admin;
  try {
    admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(adminKeypairJson)));
  } catch {
    return { skipped: true, reason: "ADMIN_KEYPAIR_JSON malformed" };
  }

  const devnet = isDevnet(rpcUrl);
  const usdcMint = devnet ? MINTS.USDC_DEVNET : MINTS.USDC_MAINNET;

  const inputMint = intent.inputMint === "SOL" ? MINTS.SOL : usdcMint;
  const outputMint = intent.outputMint === "SOL" ? MINTS.SOL : usdcMint;

  // Convert USD → atomic units
  // SOL = lamports (1 SOL = 1e9), USDC = micro-USDC (1 USDC = 1e6)
  let inputAmount;
  if (intent.inputMint === "SOL") {
    const solAmount = amountUsd / oraclePriceA;
    inputAmount = Math.round(solAmount * 1e9); // lamports
  } else {
    inputAmount = Math.round(amountUsd * 1e6); // micro-USDC
  }

  if (inputAmount < 1000) {
    return { skipped: true, reason: "swap amount too small (<1000 atoms)" };
  }

  try {
    // ── 1. Get quote ────────────────────────────────────────────────────────
    const quoteUrl =
      `${JUPITER_SWAP_API}/quote` +
      `?inputMint=${inputMint}` +
      `&outputMint=${outputMint}` +
      `&amount=${inputAmount}` +
      `&slippageBps=${slippageBps}`;

    const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(10000) });
    if (!quoteRes.ok) {
      const txt = await quoteRes.text();
      return { skipped: false, error: `Jupiter quote error ${quoteRes.status}: ${txt.slice(0, 200)}` };
    }
    const quote = await quoteRes.json();

    // ── 2. Get swap transaction ─────────────────────────────────────────────
    const swapRes = await fetch(`${JUPITER_SWAP_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: admin.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto"
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!swapRes.ok) {
      const txt = await swapRes.text();
      return { skipped: false, error: `Jupiter swap error ${swapRes.status}: ${txt.slice(0, 200)}` };
    }

    const { swapTransaction } = await swapRes.json();

    // ── 3. Sign + send ──────────────────────────────────────────────────────
    const connection = new Connection(rpcUrl, "confirmed");
    const txBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([admin]);

    const signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3
    });

    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );

    return {
      skipped: false,
      direction: intent.direction,
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      inputAmount,
      outAmount: quote.outAmount,
      signature,
      explorer: `https://explorer.solana.com/tx/${signature}${devnet ? "?cluster=devnet" : ""}`
    };
  } catch (err) {
    return { skipped: false, error: err.message };
  }
}
