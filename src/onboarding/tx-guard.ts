/**
 * tx-guard.ts — the fail-closed Balance-delegation guard (v1.4.0, gate 5).
 *
 * The engine hands the CLI an UNSIGNED `approve_checked` transaction that grants
 * an SPL delegate on the agent's own USDC token account. Before we ever sign it
 * with the local key, we DECODE the transaction and assert the delegate is the
 * pinned `vault_authority` PDA — exactly the guard the website runs. A tampered
 * or wrong-delegate approve is rejected and never signed. This is pure (no RPC),
 * so it is fully unit-testable offline.
 */
import { Transaction, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

/** SPL Token instruction discriminator for ApproveChecked. */
const APPROVE_CHECKED_IX = 13;
/** Account index of the delegate in an ApproveChecked instruction:
 *  [source, mint, delegate, owner]. */
const DELEGATE_ACCOUNT_INDEX = 2;

export class DelegateGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegateGuardError";
  }
}

/**
 * Decode a base64 (optionally partially-signed) transaction and return the
 * delegate pubkey of its first ApproveChecked instruction, or null if there is
 * no such instruction (which is itself a red flag). Pure.
 */
export function extractApproveDelegate(base64Tx: string): string | null {
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(base64Tx, "base64"));
  } catch (e) {
    throw new DelegateGuardError(
      `Could not decode the approval transaction for inspection: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(TOKEN_PROGRAM_ID)) continue;
    if (ix.data.length === 0 || ix.data[0] !== APPROVE_CHECKED_IX) continue;
    const key = ix.keys[DELEGATE_ACCOUNT_INDEX];
    if (!key) return null;
    return key.pubkey.toBase58();
  }
  return null;
}

/**
 * Fail-closed assertion: the approve transaction must (a) be built toward the
 * expected pinned delegate as reported by the engine, AND (b) actually contain
 * an ApproveChecked whose on-tx delegate account equals that same pinned key.
 * Both must agree or we refuse to sign. Pure.
 *
 * @param base64Tx      the engine-supplied unsigned (or fee-payer-signed) tx
 * @param reportedDelegate the `vault_authority` the engine claims in its JSON
 * @param pinnedDelegate the delegate we hard-code + trust (VAULT_AUTHORITY_PINNED)
 */
export function assertPinnedDelegate(
  base64Tx: string,
  reportedDelegate: string | null | undefined,
  pinnedDelegate: string,
): void {
  // Sanity: the pinned value must be a real pubkey (guards against a bad constant).
  try {
    // eslint-disable-next-line no-new
    new PublicKey(pinnedDelegate);
  } catch {
    throw new DelegateGuardError(`Pinned delegate is not a valid public key: ${pinnedDelegate}`);
  }

  if (reportedDelegate && reportedDelegate !== pinnedDelegate) {
    throw new DelegateGuardError(
      `Refusing to sign: the server asked to delegate to ${reportedDelegate}, not the expected ` +
        `${pinnedDelegate}. Your Balance was NOT touched. Stop and report this.`,
    );
  }

  const onTx = extractApproveDelegate(base64Tx);
  if (onTx === null) {
    throw new DelegateGuardError(
      "Refusing to sign: the approval transaction contains no recognizable delegation instruction. " +
        "Your Balance was NOT touched.",
    );
  }
  if (onTx !== pinnedDelegate) {
    throw new DelegateGuardError(
      `Refusing to sign: the approval transaction delegates to ${onTx}, not the expected ` +
        `${pinnedDelegate}. Your Balance was NOT touched. Stop and report this.`,
    );
  }
}
