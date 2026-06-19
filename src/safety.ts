/**
 * safety.ts — guards that prevent irreversible wallet loss during setup.
 *
 * Three real-money incidents motivated this module (post-launch feedback, P0):
 *   1. `--reset --import` wiped ~/.omniology — including the file `--import` was
 *      pointing at — BEFORE the import keypair was read. Result: ENOENT, a fresh
 *      empty wallet, and 1 USDC stranded at the abandoned address. (cli.main now
 *      reads the import keypair into memory before any reset.)
 *   2. A second `init` on the same machine silently overwrote a funded keypair,
 *      abandoning the first agent's wallet — the MCP server then signed as the
 *      new key and every submission failed with "unknown signer".
 *   3. `--reset` erased a funded wallet with no confirmation at all.
 *
 * The shared remedies live here: inspect on-chain balance before destroying a
 * key, back up ~/.omniology before any destructive write, and a pure
 * decideOverwrite() that the CLI consults before clobbering an existing keypair.
 */
import { existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getBalances, type Balances } from "./funding.js";
import { omniologyDir } from "./paths.js";

export interface WalletStatus {
  address: string;
  balances: Balances;
  hasFunds: boolean;
}

/**
 * Read the on-chain balance of a keypair file, if it exists and is readable.
 * Returns null when there's nothing to protect (no file / unreadable key).
 * `loadKp` is injected so this stays decoupled from wallet.ts for testing.
 */
export async function inspectExistingWallet(
  path: string,
  rpcUrl: string,
  loadKp: (p: string) => Keypair,
  readBalances: (c: Connection, owner: PublicKey) => Promise<Balances> = getBalances,
): Promise<WalletStatus | null> {
  if (!existsSync(path)) return null;
  let kp: Keypair;
  try {
    kp = loadKp(path);
  } catch {
    return null; // unreadable/garbage keypair → no funds we can lose
  }
  const connection = new Connection(rpcUrl, "confirmed");
  const balances = await readBalances(connection, kp.publicKey);
  return {
    address: kp.publicKey.toBase58(),
    balances,
    hasFunds: balances.usdc > 0 || balances.sol > 0,
  };
}

/**
 * Copy a directory (default ~/.omniology) into a timestamped backup under
 * ~/.omniology.bak/<ts>/ before a destructive operation. Returns the backup
 * path, or null if there was nothing to back up. `srcDir`/`bakRoot`/`now` are
 * injectable for tests.
 */
export function backupOmniologyDir(
  now: () => number = Date.now,
  srcDir: string = omniologyDir(),
  bakRoot: string = join(homedir(), ".omniology.bak"),
): string | null {
  if (!existsSync(srcDir)) return null;
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const dest = join(bakRoot, stamp);
  cpSync(srcDir, dest, { recursive: true });
  return dest;
}

export type OverwriteDecision =
  | { action: "proceed" } // nothing to protect, or re-importing the same key
  | { action: "blocked"; status: WalletStatus } // funded + no --force-overwrite
  | { action: "forced"; status: WalletStatus }; // funded + --force-overwrite

/**
 * Pure: decide whether overwriting the keypair at a path is allowed.
 *  - No existing wallet, or it has no funds                 → proceed
 *  - Re-importing the exact same wallet address             → proceed
 *  - Existing wallet is funded and we'd replace it:
 *      --force-overwrite given                              → forced (warn + back up)
 *      otherwise                                            → blocked (abort)
 */
export function decideOverwrite(
  existing: WalletStatus | null,
  newAddress: string | undefined,
  forceOverwrite: boolean,
): OverwriteDecision {
  if (!existing) return { action: "proceed" };
  if (newAddress && newAddress === existing.address) return { action: "proceed" };
  if (!existing.hasFunds) return { action: "proceed" };
  return forceOverwrite ? { action: "forced", status: existing } : { action: "blocked", status: existing };
}
