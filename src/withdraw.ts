/**
 * withdraw.ts — `omniology-init --withdraw`: move USDC out of the agent wallet
 * to any address, signed locally with the same keypair. Backup path for users
 * not running an agent host (the in-chat withdraw_to_address tool is primary).
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { USDC_MINT } from "./constants.js";

const USDC_DECIMALS = 6;

/** Current USDC balance (uiAmount) of a wallet; 0 if no token account. */
export async function usdcBalance(connection: Connection, owner: PublicKey): Promise<number> {
  const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), owner, false);
  const acct = await getAccount(connection, ata).catch(() => null);
  return acct ? Number(acct.amount) / 10 ** USDC_DECIMALS : 0;
}

export interface WithdrawOutcome {
  signature: string;
  amount_usdc: number;
  destination: string;
}

/**
 * Withdraw `amountUsdc` (or the full balance if undefined) to `destination`.
 * Throws Error with a plain-English message on failure.
 */
export async function withdraw(
  connection: Connection,
  keypair: Keypair,
  destinationAddr: string,
  amountUsdc: number | undefined,
): Promise<WithdrawOutcome> {
  let destination: PublicKey;
  try {
    destination = new PublicKey(destinationAddr.trim());
  } catch {
    throw new Error(`"${destinationAddr}" is not a valid Solana address.`);
  }

  const mint = new PublicKey(USDC_MINT);
  const balance = await usdcBalance(connection, keypair.publicKey);
  const amount = amountUsdc ?? balance;
  if (balance <= 0) throw new Error("Your wallet has no USDC to withdraw.");
  if (amount <= 0) throw new Error("Withdraw amount must be greater than 0.");
  if (amount > balance + 1e-9) {
    throw new Error(`You asked to withdraw ${amount} USDC but the wallet holds ${balance}.`);
  }

  const sourceAta = await getAssociatedTokenAddress(mint, keypair.publicKey, false);
  const destAta = await getAssociatedTokenAddress(mint, destination, false);
  const amountBase = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight }).add(
    createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, destAta, destination, mint),
    createTransferCheckedInstruction(sourceAta, mint, destAta, keypair.publicKey, amountBase, USDC_DECIMALS),
  );
  tx.sign(keypair);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes("insufficient") && (msg.includes("lamport") || msg.includes("rent") || msg.includes("sol"))) {
      throw new Error("Your wallet needs a little SOL to pay the network fee (≈0.001, or ≈0.003 if the destination has no USDC account yet). Add a tiny bit of SOL and retry.");
    }
    throw new Error(`Withdrawal couldn't be broadcast: ${err instanceof Error ? err.message : String(err)}`);
  }
  const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`Withdrawal rejected on-chain: ${JSON.stringify(conf.value.err)}`);

  return { signature, amount_usdc: amount, destination: destination.toBase58() };
}
