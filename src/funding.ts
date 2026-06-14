/** funding.ts — read SOL + USDC balances and wait until the wallet is funded. */
import { Connection, PublicKey } from "@solana/web3.js";
import { USDC_MINT } from "./constants.js";

export interface Balances {
  sol: number;
  usdc: number;
}

/** Pure: is the wallet funded enough to proceed? */
export function meetsThreshold(b: Balances, minSol: number, minUsdc: number): boolean {
  return b.sol >= minSol && b.usdc >= minUsdc;
}

/** Read SOL + USDC balances for an owner (impure: hits RPC). Never throws. */
export async function getBalances(connection: Connection, owner: PublicKey): Promise<Balances> {
  let sol = 0;
  let usdc = 0;
  try {
    sol = (await connection.getBalance(owner)) / 1e9;
  } catch {
    /* leave 0 */
  }
  try {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC_MINT) });
    for (const { account } of res.value) {
      const amt = (account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } })
        ?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof amt === "number") usdc += amt;
    }
  } catch {
    /* no token account yet → 0 */
  }
  return { sol, usdc };
}

export interface PollOptions {
  minSol: number;
  minUsdc: number;
  pollMs: number;
  timeoutMs: number;
  onTick?: (b: Balances, elapsedMs: number) => void;
  /** injectable for tests; defaults to getBalances */
  read?: (connection: Connection, owner: PublicKey) => Promise<Balances>;
  /** injectable clock for tests */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PollResult {
  funded: boolean;
  balances: Balances;
}

/** Poll until funded or timeout. */
export async function pollUntilFunded(
  connection: Connection,
  owner: PublicKey,
  opts: PollOptions,
): Promise<PollResult> {
  const read = opts.read ?? getBalances;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let balances: Balances = { sol: 0, usdc: 0 };
  // eslint-disable-next-line no-constant-condition
  while (true) {
    balances = await read(connection, owner);
    const elapsed = now() - start;
    opts.onTick?.(balances, elapsed);
    if (meetsThreshold(balances, opts.minSol, opts.minUsdc)) return { funded: true, balances };
    if (elapsed >= opts.timeoutMs) return { funded: false, balances };
    await sleep(opts.pollMs);
  }
}
