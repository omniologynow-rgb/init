/**
 * flow.ts — the gated-onboarding orchestrator (v1.4.0).
 *
 * Drives the SAME six gates the web wizard and ChatGPT GPT drive, in the same
 * order, against the same /api/onboard endpoints. The CLI is just the terminal
 * surface of one shared state machine.
 *
 *   1  Terms of Service      2  Account (email+password)   3  Email verification
 *   4  Username              5  Balance connect + approve   6  Spending limits (opt-in)
 *
 * `runGates(deps, inputs)` is the pure-ish state machine (all IO/wallet/clock
 * injected) so the gate sequence is unit-testable with a mocked API. Gate 5's
 * delegation target is verified against the pinned vault authority BEFORE the
 * local key ever signs (fail-closed) — the private key never leaves the machine.
 */
import { Connection, Keypair } from "@solana/web3.js";
import { existsSync } from "node:fs";
import {
  ONBOARD_API_BASE,
  TERMS_VERSION,
  TERMS_URL,
  VAULT_AUTHORITY_PINNED,
  ENTRY_FEE_USDC,
  SUGGESTED_USDC,
  GATE3_POLL_MS,
  GATE3_TIMEOUT_MS,
  DEFAULT_DAILY_CAP_USDC,
  DEFAULT_PER_ENTRY_CAP_USDC,
  ALL_TRACKS,
  FUNDING_POLL_MS,
  FUNDING_TIMEOUT_MS,
} from "../constants.js";
import { c, box, step as uiStep, ok as uiOk, warn as uiWarn, info as uiInfo } from "../ui.js";
import { keypairPath } from "../paths.js";
import { generateKeypair, loadKeypair, saveKeypair, printAddressQr } from "../wallet.js";
import { pollUntilFunded } from "../funding.js";
import { PublicKey } from "@solana/web3.js";
import { httpOnboardApi, OnboardApiError, type OnboardApi, type Gate6Payload, type SpendingLimits } from "./api.js";
import { firstIncompleteGate, gateLabel, isComplete, GATE_COUNT, type OnboardStatus } from "./gates.js";
import { assertPinnedDelegate } from "./tx-guard.js";
import { signAndBroadcastApprove } from "./wallet-ops.js";
import {
  ask,
  confirm,
  askHidden,
  isInteractive,
  pollWithCountdown,
} from "./prompts.js";
import {
  readOnboardingState,
  saveOnboardingState,
  tokenStillValid,
} from "./state.js";

// ── Injectable surfaces ───────────────────────────────────────────────────────

/** Terminal interaction surface (mockable for tests). */
export interface OnboardIo {
  interactive: boolean;
  step(gate: number): void;
  log(msg: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  printTosSummary(): void;
  confirm(question: string, def?: boolean): Promise<boolean>;
  ask(question: string, def?: string): Promise<string>;
  askEmail(): Promise<string>;
  askPassword(): Promise<string>;
  pollGate3(check: () => Promise<boolean>): Promise<boolean>;
}

/** Gate-5 wallet operations (mockable for tests — no Solana in the unit test). */
export interface WalletGate {
  /** Ensure a local keypair exists; return its base58 pubkey (never overwrites). */
  preparePubkey(): Promise<string>;
  /** Show the funding address + wait until USDC arrives (creates the USDC ATA). */
  ensureFunded(pubkey: string): Promise<void>;
  /** Sign the (already delegate-guarded) approve tx locally + broadcast. */
  signAndBroadcast(unsignedTxBase64: string, opts: { enginePaysFee: boolean }): Promise<string>;
}

export type Gate6Choice =
  | { mode: "ask" }
  | { mode: "no_limits" }
  | { mode: "limits"; limits: SpendingLimits };

export interface OnboardInputs {
  email?: string;
  password?: string;
  username?: string;
  acceptTos: boolean;
  capUsdc?: number;
  gate6: Gate6Choice;
  resume: boolean;
}

export interface GateDeps {
  api: OnboardApi;
  io: OnboardIo;
  wallet: WalletGate;
  pinnedDelegate: string;
  tosVersion: string;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  saveState: (patch: {
    email: string;
    onboarding_token: string;
    agent_id?: string;
    wallet_address?: string;
  }) => void;
  /** Prior saved state, if any (drives resume). */
  initialState: { email: string; onboarding_token: string; valid: boolean; agent_id?: string } | null;
}

export interface GateResult {
  email: string;
  agentId?: string;
  walletAddress?: string;
  alreadyComplete: boolean;
}

// ── The state machine ─────────────────────────────────────────────────────────

interface StartPlan {
  startGate?: number;
  token?: string;
  sessionId?: string;
  email?: string;
  status?: OnboardStatus;
  done?: boolean;
}

/** Decide where to begin: resume a valid session, log back in, or start fresh. */
async function resolveStart(deps: GateDeps, inputs: OnboardInputs): Promise<StartPlan> {
  const { api, io, initialState } = deps;

  // 1) A still-valid saved token → fetch status, jump to first incomplete gate.
  if (initialState?.valid) {
    try {
      const status = await api.status(initialState.onboarding_token);
      if (isComplete(status.gates)) return { done: true, status, email: status.email, token: initialState.onboarding_token };
      io.info(`Resuming ${status.email} at gate ${status.current_gate} (${gateLabel(status.current_gate ?? 1)}).`);
      return {
        startGate: status.current_gate ?? firstIncompleteGate(status.gates) ?? 1,
        token: initialState.onboarding_token,
        status,
        email: status.email,
      };
    } catch {
      // token rejected after all → fall through to login
    }
  }

  // 2) Explicit --resume, or an expired saved token → log back in.
  if (inputs.resume || initialState) {
    const email = initialState?.email ?? inputs.email ?? (await io.askEmail());
    io.info(`Logging in as ${email} to resume onboarding…`);
    const password = inputs.password ?? (await requirePassword(io, "Password: "));
    const { onboarding_token, status } = await api.resume({ email, password });
    deps.saveState({ email, onboarding_token });
    if (isComplete(status.gates)) return { done: true, status, email, token: onboarding_token };
    return {
      startGate: status.current_gate ?? firstIncompleteGate(status.gates) ?? 1,
      token: onboarding_token,
      status,
      email,
    };
  }

  // 3) Fresh start — open an anonymous session for the gate-1 acceptance.
  const { session_id } = await api.start();
  return { startGate: 1, sessionId: session_id };
}

async function requirePassword(io: OnboardIo, prompt: string): Promise<string> {
  if (!io.interactive) {
    throw new Error(
      "A password is required but this is a non-interactive run. Provide it with --password-stdin (echo \"$PW\" | npx omniology-init --password-stdin …).",
    );
  }
  void prompt;
  return io.askPassword();
}

/**
 * Run the six gates from `startGate`. Injectable deps make this fully testable.
 * Returns the resolved agent id + wallet once onboarding completes.
 */
export async function runGates(deps: GateDeps, inputs: OnboardInputs): Promise<GateResult> {
  const { api, io, wallet } = deps;
  const plan = await resolveStart(deps, inputs);

  if (plan.done) {
    return {
      email: plan.email ?? deps.initialState?.email ?? "",
      agentId: deps.initialState?.agent_id,
      walletAddress: plan.status?.pubkey ?? undefined,
      alreadyComplete: true,
    };
  }

  let gate = plan.startGate ?? 1;
  let token = plan.token;
  let sessionId = plan.sessionId;
  let email = plan.email ?? inputs.email;
  let agentId: string | undefined = deps.initialState?.agent_id;
  let walletAddress: string | undefined = plan.status?.pubkey ?? undefined;

  while (gate <= GATE_COUNT) {
    io.step(gate);
    switch (gate) {
      // ── Gate 1 — Terms of Service ────────────────────────────────────────
      case 1: {
        io.printTosSummary();
        const accepted = inputs.acceptTos || (await io.confirm("Accept the Terms of Service?", false));
        if (!accepted) {
          throw new Error(
            io.interactive
              ? "You must accept the Terms of Service to continue. Nothing was created."
              : "Terms of Service not accepted. Re-run with --accept-tos to accept them non-interactively.",
          );
        }
        await api.gate1({ tosVersion: deps.tosVersion, sessionId, token });
        io.ok("Terms accepted.");
        gate = 2;
        break;
      }

      // ── Gate 2 — account (email + password) ──────────────────────────────
      case 2: {
        if (!email) {
          if (!io.interactive) throw new Error("An email is required. Provide it with --email=you@example.com.");
          email = await io.askEmail();
        }
        const password =
          inputs.password ??
          (io.interactive
            ? await io.askPassword()
            : (() => {
                throw new Error(
                  "A password is required. Provide it with --password-stdin (min 12 chars, with upper/lower/number/symbol).",
                );
              })());

        try {
          const { onboarding_token } = await api.gate2({ email, password, sessionId });
          token = onboarding_token;
          deps.saveState({ email, onboarding_token });
          io.ok("Account created.");
          gate = 3;
        } catch (e) {
          if (e instanceof OnboardApiError && e.code === "EMAIL_ALREADY_REGISTERED") {
            io.info("This email already has an account — logging in to continue where you left off.");
            const { onboarding_token, status } = await api.resume({ email, password });
            token = onboarding_token;
            deps.saveState({ email, onboarding_token });
            if (isComplete(status.gates)) {
              return { email, agentId: agentId ?? deps.initialState?.agent_id, walletAddress: status.pubkey ?? walletAddress, alreadyComplete: true };
            }
            walletAddress = status.pubkey ?? walletAddress;
            gate = firstIncompleteGate(status.gates) ?? 3;
          } else {
            throw e;
          }
        }
        break;
      }

      // ── Gate 3 — email verification ──────────────────────────────────────
      case 3: {
        const t = requireToken(token);
        const send = await api.gate3Send(t);
        if (send.already_verified) {
          io.ok("Email already verified.");
          gate = 4;
          break;
        }
        io.info(`We sent a 6-digit code and a verification link to ${c.bold(email ?? "your email")}.`);
        io.info("Click the link (or it auto-continues here once you do) — valid 15 minutes.");
        const verified = await io.pollGate3(async () => (await api.gate3Status(t)).verified);
        if (!verified) {
          throw new Error(
            "Didn't see your email verified in time. When you've clicked the link, re-run with --resume to pick up here.",
          );
        }
        io.ok("Email verified.");
        gate = 4;
        break;
      }

      // ── Gate 4 — username ────────────────────────────────────────────────
      case 4: {
        const t = requireToken(token);
        const chosen = await resolveUsername(deps, inputs);
        try {
          const r = await api.gate4(t, chosen);
          io.ok(`Username set: ${r.username}`);
        } catch (e) {
          if (e instanceof OnboardApiError && e.code === "USERNAME_TAKEN" && io.interactive) {
            io.warn("That username was just taken. Let's pick another.");
            const retry = await resolveUsername(deps, { ...inputs, username: undefined });
            const r = await api.gate4(t, retry);
            io.ok(`Username set: ${r.username}`);
          } else {
            throw e;
          }
        }
        gate = 5;
        break;
      }

      // ── Gate 5 — Balance connect + approve ───────────────────────────────
      case 5: {
        const t = requireToken(token);
        const pubkey = await wallet.preparePubkey();
        walletAddress = pubkey;
        await wallet.ensureFunded(pubkey);

        const stepData = await api.gate5Local(t, { pubkey, capUsdc: inputs.capUsdc });

        // FAIL-CLOSED: verify the delegate is the pinned vault authority BEFORE signing.
        assertPinnedDelegate(stepData.unsigned_transaction, stepData.vault_authority, deps.pinnedDelegate);
        io.ok(`Delegation target verified: ${deps.pinnedDelegate.slice(0, 8)}… (pinned vault authority).`);

        const sig = await wallet.signAndBroadcast(stepData.unsigned_transaction, {
          enginePaysFee: stepData.engine_pays_network_fee,
        });
        io.ok(`Approval broadcast (${sig.slice(0, 8)}…). Confirming on-chain…`);

        const confirmed = await confirmGate5WithRetry(deps, t, sig);
        agentId = confirmed.agent_id;
        deps.saveState({
          email: email ?? "",
          onboarding_token: t,
          agent_id: agentId,
          wallet_address: pubkey,
        });
        io.ok(`Balance connected — agent ${agentId.slice(0, 8)}… is ready to compete.`);
        gate = 6;
        break;
      }

      // ── Gate 6 — spending limits (OPT-IN) ────────────────────────────────
      case 6: {
        const t = requireToken(token);
        const payload = await resolveGate6(deps, inputs);
        await api.gate6(t, payload);
        if ("no_limits" in payload) {
          io.ok("No spending limits set — your caps are open. You can add limits anytime from your dashboard.");
        } else {
          io.ok(
            `Spending limits saved: $${payload.daily_cap_usdc.toFixed(2)}/day, ` +
              `$${payload.per_entry_cap_usdc.toFixed(2)}/entry, tracks: ${payload.enabled_tracks.join(", ")}.`,
          );
        }
        gate = 7;
        break;
      }
    }
  }

  return { email: email ?? "", agentId, walletAddress, alreadyComplete: false };
}

function requireToken(token: string | undefined): string {
  if (!token) throw new Error("Internal error: reached a gate that needs an account token without one. Re-run with --resume.");
  return token;
}

/** Gate-5 confirm can 400 briefly while the approve finalizes — retry a few times. */
async function confirmGate5WithRetry(
  deps: GateDeps,
  token: string,
  sig: string,
): Promise<{ agent_id: string; remaining_usdc: number | null }> {
  const attempts = 6;
  for (let i = 0; i < attempts; i++) {
    try {
      return await deps.api.gate5Confirm(token, sig);
    } catch (e) {
      const retryable = e instanceof OnboardApiError && (e.code === "INVALID_TRANSACTION" || e.status >= 500);
      if (!retryable || i === attempts - 1) throw e;
      await deps.clock.sleep(3000);
    }
  }
  // unreachable
  throw new Error("Could not confirm the approval.");
}

/** Resolve a username: flag → interactive prompt with availability check + suggestions. */
async function resolveUsername(deps: GateDeps, inputs: OnboardInputs): Promise<string> {
  const { api, io } = deps;
  let desired = inputs.username;

  // Non-interactive: the flag value is authoritative (server re-checks + 409s).
  if (!io.interactive) {
    if (!desired) throw new Error("A username is required. Provide it with --username=<name>.");
    const avail = await api.usernameAvailable(desired);
    if (!avail.available) {
      throw new Error(`Username "${desired}" isn't available: ${avail.message ?? avail.reason ?? "taken"}.`);
    }
    return desired;
  }

  // Interactive: loop until an available handle is chosen.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!desired) desired = await io.ask("Pick a username (letters, numbers, dashes): ");
    if (!desired) continue;
    const avail = await api.usernameAvailable(desired);
    if (avail.available) return desired;
    io.warn(avail.message ?? `"${desired}" is not available.`);
    const alts = suggestUsernames(desired);
    io.info(`Ideas: ${alts.join("  ")}`);
    desired = undefined;
  }
}

/** Deterministic alternate suggestions on a collision (no RNG — index-varied). */
export function suggestUsernames(base: string): string[] {
  const root = base.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 20) || "agent";
  return [`${root}-1`, `${root}-2`, `${root}-hq`, `the-${root}`];
}

/** Resolve the gate-6 payload: opt-out by default; prompt the three values only on yes. */
async function resolveGate6(deps: GateDeps, inputs: OnboardInputs): Promise<Gate6Payload> {
  const { io } = deps;
  if (inputs.gate6.mode === "no_limits") return { no_limits: true };
  if (inputs.gate6.mode === "limits") return inputs.gate6.limits;

  // mode === 'ask'
  if (!io.interactive) return { no_limits: true }; // non-interactive default = no limits
  const wantsLimits = await io.confirm("Set spending limits for your agent?", false);
  if (!wantsLimits) return { no_limits: true };

  const daily = await promptCap(io, "Daily spending cap (USDC)", DEFAULT_DAILY_CAP_USDC);
  const perEntry = await promptCap(io, "Per-entry cap (USDC)", DEFAULT_PER_ENTRY_CAP_USDC);
  const tracks = await promptTracks(io);
  return { daily_cap_usdc: daily, per_entry_cap_usdc: perEntry, enabled_tracks: tracks };
}

async function promptCap(io: OnboardIo, label: string, def: number): Promise<number> {
  const raw = await io.ask(`${label} [default $${def.toFixed(2)}]: `, String(def));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

async function promptTracks(io: OnboardIo): Promise<string[]> {
  const raw = (await io.ask(`Enabled tracks (comma-separated, or "all") [default all]: `, "all")).trim().toLowerCase();
  if (raw === "" || raw === "all") return [...ALL_TRACKS];
  const picked = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => (ALL_TRACKS as readonly string[]).includes(s));
  return picked.length ? picked : [...ALL_TRACKS];
}

// ── Real dependency assembly (used by the CLI; not by the unit test) ──────────

function buildTosSummary(): string[] {
  return [
    c.bold("Terms of Service — the short version"),
    "",
    "• Omniology runs AI skill competitions on Solana. Entering the text tracks",
    `  (ART / STORY / JOKE) costs a ${c.green(`$${ENTRY_FEE_USDC.toFixed(2)}`)} entry fee in USDC.`,
    "• Your Balance stays in your own wallet. You approve a spending delegation",
    "  that you can revoke at any time — funds only move when you enter.",
    "• You must be 18+ and in an eligible region. Prizes are awarded in USDC and",
    "  may be reportable income (a tax form may be issued).",
    "• Scores are decided by an automated judge; there is no guarantee of winning.",
    "",
    `Full text: ${c.cyan(TERMS_URL)}`,
  ];
}

/** The real terminal IO surface. */
function realIo(): OnboardIo {
  return {
    interactive: isInteractive(),
    step(gate: number) {
      uiStep(gate, GATE_COUNT, gateLabel(gate));
    },
    log: (m) => uiInfo(m),
    ok: uiOk,
    warn: uiWarn,
    info: uiInfo,
    printTosSummary() {
      console.log("");
      for (const line of buildTosSummary()) console.log("  " + line);
    },
    confirm: (q, def = false) => confirm(q, def),
    ask: (q, def = "") => ask(q, def),
    async askEmail() {
      const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
      let email = await ask("Email (for verification + prize/tax notices): ");
      while (isInteractive() && !isEmail(email)) email = await ask("Please enter a valid email address: ");
      return email;
    },
    async askPassword() {
      // Policy: ≥12 chars with upper + lower + number + symbol. Echo a clear
      // reason on a weak password; confirm by re-entry.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pw = await askHidden("Create a password (min 12 chars, upper/lower/number/symbol): ");
        const reason = passwordPolicyReason(pw);
        if (reason) {
          uiWarn(reason);
          continue;
        }
        const again = await askHidden("Confirm password: ");
        if (again !== pw) {
          uiWarn("Passwords didn't match — try again.");
          continue;
        }
        return pw;
      }
    },
    pollGate3(check) {
      return pollWithCountdown({
        check,
        pollMs: GATE3_POLL_MS,
        timeoutMs: GATE3_TIMEOUT_MS,
        label: "Waiting for email verification…",
      });
    },
  };
}

/** Client-side mirror of the engine's password policy V2 (nice local errors). */
export function passwordPolicyReason(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters.";
  if (pw.length > 200) return "Password must be at most 200 characters.";
  if (!/[A-Z]/.test(pw)) return "Password must contain an uppercase letter.";
  if (!/[a-z]/.test(pw)) return "Password must contain a lowercase letter.";
  if (!/[0-9]/.test(pw)) return "Password must contain a number.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password must contain a symbol.";
  return null;
}

/** The real gate-5 wallet surface (local keypair path). */
function realWallet(opts: { rpcUrl: string; skipFunding: boolean; minSol: number; minUsdc: number }): WalletGate {
  let keypair: Keypair | null = null;
  const connection = new Connection(opts.rpcUrl, "confirmed");

  return {
    async preparePubkey() {
      const path = keypairPath();
      if (existsSync(path)) {
        keypair = loadKeypair(path);
        uiOk(`Using your existing wallet ${keypair.publicKey.toBase58().slice(0, 8)}…`);
      } else {
        keypair = generateKeypair();
        saveKeypair(path, keypair);
        uiOk(`New wallet created → ${path}${process.platform !== "win32" ? " (private, chmod 600)" : ""}`);
      }
      return keypair.publicKey.toBase58();
    },
    async ensureFunded(pubkey: string) {
      console.log("");
      console.log("  Fund your agent's Balance — send " + c.green("USDC (Solana)") + " to:");
      console.log("");
      console.log("    " + c.bold(c.green(pubkey)));
      console.log("");
      await printAddressQr(pubkey);
      console.log(`  Suggested first deposit: ${c.bold(c.green(`${SUGGESTED_USDC} USDC`))} (covers several entries at $${ENTRY_FEE_USDC.toFixed(2)} each).`);
      if (opts.skipFunding) {
        uiWarn(
          "Skipping the funding wait (--skip-funding). Gate 5 needs USDC on-chain to approve the delegation — " +
            "fund the address above, then re-run with --resume.",
        );
        throw new Error("Funding required for gate 5. Fund the address above and re-run with --resume.");
      }
      console.log("");
      uiInfo(`Waiting for your Balance… (checking every ${FUNDING_POLL_MS / 1000}s, Ctrl+C to stop)`);
      let lastLine = "";
      const result = await pollUntilFunded(connection, new PublicKey(pubkey), {
        minSol: opts.minSol,
        minUsdc: opts.minUsdc,
        pollMs: FUNDING_POLL_MS,
        timeoutMs: FUNDING_TIMEOUT_MS,
        onTick: (b) => {
          const line = `  …Balance so far: ${b.usdc.toFixed(2)} USDC${opts.minSol > 0 ? ` / ${b.sol.toFixed(4)} SOL` : ""}`;
          if (line !== lastLine) {
            console.log(line);
            lastLine = line;
          }
        },
      });
      if (!result.funded) {
        throw new Error(
          `Didn't see USDC within ${Math.round(FUNDING_TIMEOUT_MS / 60000)} minutes. Fund the address above and re-run with --resume.`,
        );
      }
      uiOk(`Detected ${result.balances.usdc.toFixed(2)} USDC. Ready to connect.`);
    },
    async signAndBroadcast(unsignedTxBase64, connectOpts) {
      if (!keypair) throw new Error("Wallet not prepared.");
      if (!connectOpts.enginePaysFee) {
        uiWarn("Omniology couldn't fee-pay this transaction — your wallet will pay the ~0.000005 SOL network fee.");
      }
      const { signature } = await signAndBroadcastApprove(connection, keypair, unsignedTxBase64);
      return signature;
    },
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

export interface RunOnboardingOptions {
  email?: string;
  password?: string; // pre-read from --password-stdin
  username?: string;
  acceptTos: boolean;
  resume: boolean;
  capUsdc?: number;
  gate6: Gate6Choice;
  rpcUrl: string;
  skipFunding: boolean;
  minSol: number;
  minUsdc: number;
}

/**
 * Assemble real dependencies and run the gated onboarding. Returns the resolved
 * agent id + wallet so the caller can install the MCP host connector.
 */
export async function runOnboarding(opts: RunOnboardingOptions): Promise<GateResult> {
  const api = httpOnboardApi(ONBOARD_API_BASE);
  const io = realIo();
  const wallet = realWallet({ rpcUrl: opts.rpcUrl, skipFunding: opts.skipFunding, minSol: opts.minSol, minUsdc: opts.minUsdc });

  const saved = readOnboardingState();
  const initialState = saved
    ? { email: saved.email, onboarding_token: saved.onboarding_token, valid: tokenStillValid(saved), agent_id: saved.agent_id }
    : null;

  const deps: GateDeps = {
    api,
    io,
    wallet,
    pinnedDelegate: VAULT_AUTHORITY_PINNED,
    tosVersion: TERMS_VERSION,
    clock: { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    saveState: (patch) => saveOnboardingState(patch),
    initialState,
  };

  const inputs: OnboardInputs = {
    email: opts.email,
    password: opts.password,
    username: opts.username,
    acceptTos: opts.acceptTos,
    capUsdc: opts.capUsdc,
    gate6: opts.gate6,
    resume: opts.resume,
  };

  return runGates(deps, inputs);
}

/** Completion banner shown after the host connector is installed. */
export function completionBox(dashboardUrl: string, openHint: string): void {
  box([
    c.bold(c.green("✓ You're set — your agent can compete.")),
    "",
    openHint,
    "",
    "Then tell your agent:",
    c.cyan('  "Compete in Omniology contests for me —'),
    c.cyan('   keep playing until I tell you to stop."'),
    "",
    c.dim(`Watch live: ${dashboardUrl}`),
  ]);
}
