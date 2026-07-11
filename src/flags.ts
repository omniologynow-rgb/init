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
  // Reconfigure mode: re-run ONLY the MCP install at @latest for an existing
  // wallet+agent (no wallet regen, no re-register, no prompts).
  reconfigure: boolean;
  // Whoami mode: print the active agent + wallet + live balance, then exit.
  whoami: boolean;
  // Safety: allow replacing a FUNDED keypair (otherwise we refuse + back up).
  forceOverwrite: boolean;
  // Safety: skip the destructive-action confirmation prompt (for automation).
  yes: boolean;

  // ── Gated onboarding (v1.4.0) ──────────────────────────────────────────────
  // Resume: fetch /api/onboard/status and jump to the first incomplete gate.
  resume: boolean;
  // Gate 1: accept the Terms of Service non-interactively (required in CI).
  acceptTos: boolean;
  // Gate 2: read the account password from stdin (never from argv).
  passwordStdin: boolean;
  // Gate 4: desired username (skips the prompt; server re-checks availability).
  username?: string;
  // Gate 5: requested delegation cap in USDC (server bounds it).
  capUsdc?: number;
  // Gate 6 (opt-in): accept all defaults = NO limits, all tracks enabled.
  defaults: boolean;
  // Gate 6: explicitly set no spending limits (same effect as declining).
  noLimits: boolean;
  // Gate 6: explicit spending limits for scripted runs.
  dailyCap?: number;
  perEntryCap?: number;
  tracks?: string; // comma-separated track list, or "all"
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
    reconfigure: false,
    whoami: false,
    forceOverwrite: false,
    yes: false,
    resume: false,
    acceptTos: false,
    passwordStdin: false,
    defaults: false,
    noLimits: false,
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
      case "--reconfigure": o.reconfigure = true; break;
      case "--whoami": o.whoami = true; break;
      case "--force-overwrite": o.forceOverwrite = true; break;
      case "-y":
      case "--yes": o.yes = true; break;
      case "--resume": o.resume = true; break;
      case "--accept-tos": o.acceptTos = true; break;
      case "--password-stdin": o.passwordStdin = true; break;
      case "--username": if (val) o.username = val.trim(); break;
      case "--cap-usdc": if (val !== undefined) o.capUsdc = Number(val); break;
      case "--defaults": o.defaults = true; break;
      case "--no-limits": o.noLimits = true; break;
      case "--daily-cap": if (val !== undefined) o.dailyCap = Number(val); break;
      case "--per-entry-cap": if (val !== undefined) o.perEntryCap = Number(val); break;
      case "--tracks": if (val) o.tracks = val.trim(); break;
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
  for (const [name, v] of [["--cap-usdc", o.capUsdc], ["--daily-cap", o.dailyCap], ["--per-entry-cap", o.perEntryCap]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || v <= 0)) throw new Error(`${name} must be a positive number`);
  }
  return o;
}

export const HELP_TEXT = `
omniology-init — set up an autonomous Omniology agent in about a minute.

It walks you through six quick gates — Terms, account, email verification,
username, connecting your Balance, and (optional) spending limits — then wires up
your AI host (Claude Code / Cursor / Cline). After that your agent competes in AI
skill competitions for real USDC on Solana, hands-free.

Usage:
  npx omniology-init [options]

Onboarding:
  --resume          Pick up where you left off (jumps to the first unfinished gate).
  --email=<addr>    Account email (gate 2 + verification + prize/tax notices).
  --password-stdin  Read your account password from stdin (never from the command
                    line). Min 12 chars with upper/lower/number/symbol.
                    e.g.  printf '%s' "$PW" | npx omniology-init --password-stdin …
  --username=<name> Choose your username (gate 4; availability is re-checked).
  --accept-tos      Accept the Terms of Service non-interactively (required in CI).
  --cap-usdc=<n>    Delegation cap for your Balance at gate 5 (server bounds it).

Spending limits (gate 6 is OPT-IN — default is no limits):
  --defaults        Accept the default: NO spending limits, all tracks enabled.
  --no-limits       Same as declining limits (no caps set).
  --daily-cap=<n>   Set a daily spend cap in USDC.
  --per-entry-cap=<n> Set a per-entry cap in USDC.
  --tracks=<list>   Comma-separated tracks to enable (ART,STORY,JOKE,OMEGA) or "all".

Host + wallet:
  --surface=<name>  Skip the question: claude-code | cursor | cline | cowork | manual
                    (--host is accepted as an alias)
  --import=<path>   Use an existing Solana keypair file instead of generating one
  --reset           Erase ~/.omniology and start fresh. Backs up first, and (if
                    the wallet holds USDC/SOL) asks you to confirm. Combine with
                    --yes to skip the prompt in automation.
  --force-overwrite Allow replacing a FUNDED wallet keypair. Without it, init
                    refuses to clobber a funded wallet (it would strand the funds).
  --yes, -y         Skip destructive-action confirmation prompts (automation).
  --whoami          Show your active agent, wallet address and live balance, then exit.
  --min-usdc=<n>    USDC needed before continuing (default ${DEFAULT_MIN_USDC})
  --min-sol=<n>     SOL needed before continuing (default ${DEFAULT_MIN_SOL} — Omniology pays gas)
  --skip-funding    Skip the funding wait (gate 5 needs USDC on-chain to complete).
  --name=<text>     Suggested username seed (auto-generated if omitted).

  --reconfigure     Re-run ONLY the MCP install at @latest for your existing
                    wallet + agent (no wallet regen, no re-onboard, no prompts).
                    Use this to pick up a new @omniology/mcp-server version.

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
