/**
 * wallet-ops.ts — gate-5 local-keypair signing + broadcast.
 *
 * The engine returns a fee-payer-signed (or, if it can't fee-pay, unsigned)
 * approve_checked transaction. After the delegate guard passes, we add the
 * agent's signature locally and broadcast. The private key never leaves the
 * machine — the engine only ever fee-pays.
 */
import { Connection, Keypair, Transaction } from "@solana/web3.js";

export interface BroadcastResult {
  signature: string;
}

/**
 * Add the agent's signature to the (already delegate-guarded) approve tx and
 * broadcast it. Returns the confirmed signature. Throws a plain-English error on
 * failure.
 */
export async function signAndBroadcastApprove(
  connection: Connection,
  keypair: Keypair,
  unsignedTxBase64: string,
): Promise<BroadcastResult> {
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  } catch (e) {
    throw new Error(`Could not read the approval transaction: ${e instanceof Error ? e.message : String(e)}`);
  }
  tx.partialSign(keypair);

  let raw: Buffer;
  try {
    raw = tx.serialize();
  } catch (e) {
    throw new Error(
      `The approval transaction is missing a required signature (${e instanceof Error ? e.message : String(e)}). ` +
        "This usually means Omniology couldn't fee-pay — add ~0.005 SOL to your wallet and retry.",
    );
  }

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  } catch (e) {
    throw new Error(`Couldn't broadcast the approval: ${e instanceof Error ? e.message : String(e)}`);
  }

  const bh = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed",
  );
  return { signature };
}
