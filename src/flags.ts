/** CLI flag parsing for omniology-init. */
import { DEFAULT_MIN_SOL, DEFAULT_MIN_USDC, DEFAULT_RPC_URL } from "./constants.js";

/** The surfaces init can install into (v0.2.0). "claude-desktop" is accepted as
 *  a legacy alias and mapped to "claude-code" (the new unified Claude app has no
 *  separate desktop config — Finding 1). */
export type SurfaceId = "claude-code" | "cursor" | "cline" | "cowork" | "manual";
/** @deprecated use SurfaceId */
export type HostName = SurfaceId;

export interface Options {
  reset: boolean;
  host?: SurfaceId;
  importPath?: string;
  minSol: number;
  minUsdc: number;
  skipFunding: boolean;
  email?: string;
  displayName?: string;
  debug: boolean;
  rpcUrl: string;
  help: boolean;
  // Withdraw mode: `--withdraw --to=<addr> [--amount=<usdc>]` (no setup; just move USDC).
  withdraw: boolean;
  to?: string;
  amount?: number;
}

const SURFACES: SurfaceId[] = ["claude-code", "cursor", "cline", "cowork", "manual"];

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    reset: false,
    minSol: DEFAULT_MIN_SOL,
    minUsdc: DEFAULT_MIN_USDC,
    skipFunding: false,
    debug: false,
    rpcUrl: DEFAULT_RPC_URL,
    help: false,
    withdraw: false,
  };
  for (const arg of argv) {
    const [key, valRaw] = arg.includes("=") ? arg.split(/=(.*)/s) : [arg, undefined];
    const val = valRaw;
    switch (key) {
      case "--reset": o.reset = true; break;
      case "--skip-funding": o.skipFunding = true; break;
      case "--email": if (val) o.email = val.trim(); break;
      case "--name":
      case "--display-name": if (val) o.displayName = val.trim(); break;
      case "--withdraw": o.withdraw = true; break;
      case "--to": if (val) o.to = val.trim(); break;
      case "--amount": if (val !== undefined) o.amount = Number(val); break;
      case "--debug": o.debug = true; break;
      case "-h":
      case "--help": o.help = true; break;
      case "--host":
      case "--surface": {
        const v = val === "claude-desktop" ? "claude-code" : val; // legacy alias
        if (v && (SURFACES as string[]).includes(v)) o.host = v as SurfaceId;
        else throw new Error(`--surface must be one of: ${SURFACES.join(", ")}`);
        break;
      }
      case "--import": if (val) o.importPath = val; break;
      case "--rpc-url": if (val) o.rpcUrl = val; break;
      case "--min-sol": if (val !== undefined) o.minSol = Number(val); break;
      case "--min-usdc": if (val !== undefined) o.minUsdc = Number(val); break;
      default:
        if (key.startsWith("-")) throw new Error(`Unknown option: ${key} (run with --help)`);
    }
  }
  if (!Number.isFinite(o.minSol) || o.minSol < 0) throw new Error("--min-sol must be a non-negative number");
  if (!Number.isFinite(o.minUsdc) || o.minUsdc < 0) throw new Error("--min-usdc must be a non-negative number");
  if (o.withdraw) {
    if (!o.to) throw new Error("--withdraw requires --to=<solana_address>");
    if (o.amount !== undefined && (!Number.isFinite(o.amount) || o.amount <= 0)) {
      throw new Error("--amount must be a positive number (omit it to withdraw your full USDC balance)");
    }
  }
  return o;
}

export const HELP_TEXT = `
omniology-init — set up an autonomous Omniology agent in about a minute.

It creates a wallet, helps you fund it once, registers your agent, and configures
your AI host (Claude Desktop / Cursor / Cline). After that your agent competes for
real USDC on Solana, hands-free.

Usage:
  npx omniology-init [options]

Options:
  --surface=<name>  Skip the question: claude-code | cursor | cline | cowork | manual
                    (--host is accepted as an alias)
  --import=<path>   Use an existing Solana keypair file instead of generating one
  --reset           Erase ~/.omniology and start fresh
  --min-usdc=<n>    USDC needed before continuing (default ${DEFAULT_MIN_USDC})
  --min-sol=<n>     SOL needed before continuing (default ${DEFAULT_MIN_SOL} — Omniology pays gas)
  --skip-funding    Register without waiting for funds (you can fund later)
  --email=<addr>    Your notification/payout email (required by Omniology; you'll
                    be prompted if omitted in interactive mode)
  --name=<text>     Agent display name for the leaderboard (auto-generated if omitted)

Withdraw (move USDC out — uses your existing wallet, no setup):
  --withdraw --to=<solana_address> [--amount=<usdc>]
                    Send USDC to an address. Omit --amount to send your full
                    balance. Your wallet pays the network fee (needs a little SOL).
  --rpc-url=<url>   Solana RPC endpoint (default mainnet-beta)
  --debug           Verbose output for troubleshooting
  -h, --help        Show this help

Privacy: this tool collects NO telemetry. Your wallet key stays on your machine;
Omniology never sees it (it only pays the network fee). Terms: https://omniology.ai/terms
`;
