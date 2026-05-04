/**
 * x402 facilitator — receive a signed Solana transaction, broadcast it,
 * verify the transfer matches expected recipient + amount, return allowed/denied.
 *
 * This is the exact pattern used by Latinum's facilitator.ts, ported to ESM
 * and integrated into the mint-guard service.
 *
 * Used by:
 *   - External agents paying to call our policy tools
 *   - The x402Client when verifying outbound payments landed
 *
 * HTTP endpoint (when served by serve.js):  POST /api/x402/facilitate
 * Programmatic API:                          facilitatePayment(opts)
 */

import { Connection, PublicKey } from "@solana/web3.js";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

/**
 * Broadcast and verify a signed Solana transaction.
 *
 * @param {object} opts
 * @param {string} opts.signedTransactionB64      Base64-encoded signed transaction
 * @param {string} opts.expectedRecipient         Expected recipient pubkey (base58)
 * @param {number} opts.expectedAmountLamports    Expected transfer amount in lamports
 * @param {string} [opts.rpcUrl]
 * @returns {Promise<{allowed: boolean, txid?: string, error?: string}>}
 */
export async function facilitatePayment(opts) {
  const {
    signedTransactionB64,
    expectedRecipient,
    expectedAmountLamports,
    rpcUrl = SOLANA_RPC_URL
  } = opts;

  if (!signedTransactionB64 || !expectedRecipient || !expectedAmountLamports) {
    return { allowed: false, error: "Missing required fields" };
  }

  const connection = new Connection(rpcUrl, "confirmed");

  try {
    // Decode + broadcast
    const txBytes = Buffer.from(signedTransactionB64, "base64");
    const txid = await connection.sendRawTransaction(txBytes, {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });

    // Confirm
    const latest = await connection.getLatestBlockhash("finalized");
    await connection.confirmTransaction(
      { signature: txid, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed"
    );

    // Parse + verify
    const parsed = await connection.getParsedTransaction(txid, {
      maxSupportedTransactionVersion: 0
    });

    if (!parsed?.transaction?.message?.instructions?.length) {
      return { allowed: false, error: "Could not parse transaction" };
    }

    const expectedLamportsBig = BigInt(Math.round(expectedAmountLamports));

    const validTransfer = parsed.transaction.message.instructions.some((ix) => {
      if (ix.program !== "system" || ix.parsed?.type !== "transfer") return false;
      const recipientPubkey = ix.parsed.info.destination;
      const lamports = BigInt(ix.parsed.info.lamports);
      return (
        recipientPubkey === expectedRecipient &&
        lamports === expectedLamportsBig
      );
    });

    if (!validTransfer) {
      return { allowed: false, error: "Transfer mismatch or invalid format" };
    }

    return { allowed: true, txid };
  } catch (err) {
    return { allowed: false, error: err.message };
  }
}

/**
 * Build a signed SOL transfer transaction (wallet side — what Latinum calls "402wallet").
 * The returned base64 can be passed to facilitatePayment or the x402 client.
 *
 * @param {object} opts
 * @param {import('@solana/web3.js').Keypair} opts.payer
 * @param {string}  opts.targetWallet
 * @param {number}  opts.amountLamports
 * @param {string}  [opts.rpcUrl]
 * @returns {Promise<{success: boolean, signedTransactionB64?: string, error?: string}>}
 */
export async function buildSignedTransfer(opts) {
  const {
    payer,
    targetWallet,
    amountLamports,
    rpcUrl = SOLANA_RPC_URL
  } = opts;

  try {
    const { Connection, SystemProgram, Transaction, PublicKey: PK } = await import("@solana/web3.js");
    const connection = new Connection(rpcUrl, "confirmed");
    const recipient = new PK(targetWallet);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");

    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: Number(amountLamports)
      })
    );
    tx.sign(payer);
    const signedTransactionB64 = Buffer.from(tx.serialize()).toString("base64");
    return { success: true, signedTransactionB64, from: payer.publicKey.toBase58(), to: targetWallet, amountLamports };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
