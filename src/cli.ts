/**
 * omniology-init — one-command setup for an autonomous Omniology agent (v0.2.0).
 *
 * Flow: pick where to run (Claude Code recommended) → create/load wallet → fund
 * once (the only human action) → register → route the MCP install for that
 * surface → verify → print the exact prompt to paste. Plain English throughout.
 */
import { existsSync, rmSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Connection, Keypair } from "@solana/web3.js";
import { parseArgs, HELP_TEXT, type Options, type SurfaceId } from "./flags.js";
import { banner, box, step, ok, warn, info, arrow, c } from "./ui.js";
import { omniologyDir, keypairPath, agentPath, type AgentRecord } from "./paths.js";
import { writeConfigAtomic, readConfig, hasOmniologyServer, resolveLaunch } from "./config.js";
import { detectSurfaces } from "./surfaces/detect.js";
import { installSurface } from "./surfaces/index.js";
import { defaultExec as surfaceExec } from "./surfaces/exec.js";
import { writeSetupDoc } from "./setup-doc.js";
import { runVerify } from "./verify.js";
import type { LaunchSpec } from "./surfaces/types.js";
import { defaultExec } from "./surfaces/exec.js";
import { currentPlatform, cursorConfigPath, findClineConfigPath } from "./hosts.js";
import { loadKeypair, saveKeypair } from "./wallet.js";
import { getBalances } from "./funding.js";
import { inspectExistingWallet, backupOmniologyDir, decideOverwrite } from "./safety.js";
import { withdraw } from "./withdraw.js";
import {
  DASHBOARD_URL,
  DEFAULT_DAILY_CAP_USDC,
  DEFAULT_PER_ENTRY_CAP_USDC,
  ALL_TRACKS,
} from "./constants.js";
import { runOnboarding, completionBox, type Gate6Choice } from "./onboarding/flow.js";
import { readStdin } from "./onboarding/prompts.js";

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question: string, def = ""): Promise<string> {
  if (!interactive) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`  ${question}`)).trim();
    return ans === "" ? def : ans;
  } finally {
    rl.close();
  }
}

const isEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * Resolve how to launch the MCP server for the configs we write. Prefers the
 * global `omniology-mcp` binary (a real executable every host can spawn) over
 * `npx`, and on Windows tries to install it first — `npx` is a `.ps1`/`.cmd`
 * shim there that autonomous hosts fail to spawn (the openclaw incident). Falls
 * back to npx cleanly if the global install isn't possible.
 */
function resolveHostLaunch(): LaunchSpec {
  const ensure = process.platform === "win32";
  if (ensure) info("Making sure the omniology-mcp launcher is installed (Windows-robust; one moment)…");
  const launch = resolveLaunch(surfaceExec, { ensure });
  if (launch.command === "omniology-mcp") ok("Using the omniology-mcp binary (a real executable — no npx/PowerShell spawn issues).");
  return launch;
}

function fail(message: string, debug?: unknown, debugOn = false): never {
  console.log("");
  console.log(`  ${c.red("✗")} ${c.bold(message)}`);
  if (debugOn && debug) console.error(debug);
  console.log("");
  process.exit(1);
}

/**
 * Confirm a destructive action. Prints `message`, then: --yes proceeds; an
 * interactive TTY asks for an explicit "yes"; a non-interactive run without
 * --yes returns false (the caller decides how to bail). Never wipes silently.
 */
async function confirmDestructive(opts: Options, message: string): Promise<boolean> {
  console.log("");
  console.log("  " + message.split("\n").join("\n  "));
  if (opts.yes) {
    info("Proceeding (--yes).");
    return true;
  }
  if (!interactive) return false;
  const ans = await ask("Type 'yes' to proceed [yes/N]: ", "n");
  return ans.trim().toLowerCase() === "yes";
}

// ── Step 0: where do you want to run your agent? ─────────────────────────────
async function resolveSurface(opts: Options): Promise<SurfaceId> {
  step(0, 6, "Where do you want to run your agent?");
  if (opts.host) {
    ok(`Using ${opts.host} (from --surface)`);
    return opts.host;
  }
  const avail = detectSurfaces();
  avail.forEach((s, i) => {
    const tag = s.id !== "manual" && s.installed ? c.green(" (detected)") : "";
    arrow(`${i + 1}. ${s.label}${tag}`);
  });
  const def =
    avail.find((s) => s.recommended && s.installed) ??
    avail.find((s) => s.installed && s.id !== "manual") ??
    avail.find((s) => s.id === "manual")!;
  const defIdx = avail.indexOf(def) + 1;
  const pick = await ask(`Pick a number [default ${defIdx} = ${def.label}]: `, String(defIdx));
  const idx = Math.min(Math.max(parseInt(pick, 10) || defIdx, 1), avail.length) - 1;
  const chosen = avail[idx]!;
  ok(`Using ${chosen.label}`);
  return chosen.id;
}

/**
 * Guard before we overwrite the keypair at `path`. Refuses to clobber a FUNDED
 * wallet unless --force-overwrite is given, and always backs up the existing
 * setup first. `newAddress` is the wallet we'd be writing (so re-importing the
 * same key is recognised as a no-op rather than a destructive overwrite).
 */
async function guardOverwrite(opts: Options, path: string, newAddress?: string): Promise<void> {
  const existing = await inspectExistingWallet(path, opts.rpcUrl, loadKeypair);
  const decision = decideOverwrite(existing, newAddress, opts.forceOverwrite);

  if (decision.action === "blocked") {
    const { address, balances } = decision.status;
    fail(
      `Refusing to overwrite a FUNDED wallet.\n` +
        `    ${address}\n` +
        `    holds ${balances.usdc.toFixed(2)} USDC / ${balances.sol.toFixed(4)} SOL — its private key is at ${path}.\n` +
        `  Replacing it now would strand those funds. Options:\n` +
        `    • Keep competing with it: re-run without --import and choose "existing".\n` +
        `    • Move the funds out first: npx omniology-init --withdraw --to=<your_address>\n` +
        `    • Really replace it anyway: re-run with --force-overwrite (the old key is backed up first).`,
    );
  }

  // proceed / forced: back up whatever's there before we replace it.
  if (existing) {
    const bak = backupOmniologyDir();
    if (decision.action === "forced") {
      warn(`Overwriting funded wallet ${decision.status.address} (--force-overwrite).`);
    }
    if (bak) info(`Backed up previous setup → ${bak}`);
  }
}

// ── Withdraw mode (--withdraw) ────────────────────────────────────────────────
async function runWithdraw(opts: Options): Promise<void> {
  step(1, 1, "Withdraw USDC from your agent wallet");
  const path = keypairPath();
  if (!existsSync(path)) {
    fail(`No agent wallet found at ${path}. Run \`npx omniology-init\` first (or pass --import).`);
  }
  const kp = loadKeypair(path);
  const connection = new Connection(opts.rpcUrl, "confirmed");
  info(`From wallet: ${kp.publicKey.toBase58()}`);
  info(opts.amount !== undefined ? `Amount: ${opts.amount} USDC` : "Amount: full USDC balance");
  info(`To: ${opts.to}`);
  let res;
  try {
    res = await withdraw(connection, kp, opts.to!, opts.amount);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), err, opts.debug);
  }
  box([
    c.bold(c.green("✓ Withdrawal sent")),
    "",
    `${res.amount_usdc} USDC → ${res.destination}`,
    "",
    c.dim(`Transaction: https://solscan.io/tx/${res.signature}`),
  ]);
}

// ── Reconfigure mode (--reconfigure) ──────────────────────────────────────────

/** Find which surface already has an omniology connector configured, if any. */
function findConfiguredSurface(): SurfaceId | null {
  const p = currentPlatform();
  // Claude Code: ask the CLI.
  const list = defaultExec("claude", ["mcp", "list"]);
  if (!list.spawnError && /omniology/i.test(list.stdout)) return "claude-code";
  // Cursor / Cline: read their config files.
  for (const [id, path] of [
    ["cursor", cursorConfigPath(p)] as const,
    ["cline", findClineConfigPath(p)] as const,
  ]) {
    if (!path) continue;
    try {
      if (hasOmniologyServer(readConfig(path))) return id;
    } catch {
      /* unreadable → skip */
    }
  }
  return null;
}

async function runReconfigure(opts: Options): Promise<void> {
  step(1, 1, "Reconfigure — update Omniology to the latest MCP server");
  // Existing wallet + agent are required; no regen, no re-register.
  if (!existsSync(keypairPath())) {
    fail("No existing setup found. Run `npx omniology-init` first.");
  }
  let agent: AgentRecord;
  try {
    agent = JSON.parse(readFileSync(agentPath(), "utf8")) as AgentRecord;
    if (!agent.agent_id) throw new Error("no agent_id");
  } catch {
    fail("No existing setup found. Run `npx omniology-init` first.");
  }
  const kp = loadKeypair(keypairPath());
  if (agent.wallet_address && agent.wallet_address !== kp.publicKey.toBase58()) {
    warn("Your keypair and saved agent.json don't match — reconfiguring with the saved agent_id anyway.");
  }
  ok(`Found existing keypair: ${keypairPath()}`);
  ok(`Found existing agent: ${agent.agent_id}`);

  // Surface: explicit --surface wins; else the one already configured; else
  // auto-detect the recommended host.
  const surface =
    opts.host ??
    findConfiguredSurface() ??
    detectSurfaces().find((s) => s.installed && s.id !== "manual")?.id ??
    "manual";

  const launch = resolveHostLaunch();
  const ctx = { keypairPath: keypairPath(), agentId: agent.agent_id, opts, launch, force: true };
  const result = await installSurface(surface, ctx);
  const setupPath = writeSetupDoc(ctx);
  console.log("");
  ok(`Done${result.verified ? " (verified)" : ""}. ${result.openHint}`);
  info(`Universal setup (any host): ${setupPath}`);
}

// ── Whoami mode (--whoami) ────────────────────────────────────────────────────
async function runWhoami(opts: Options): Promise<void> {
  step(1, 1, "Your Omniology agent");
  const path = keypairPath();
  if (!existsSync(path)) {
    info("No agent wallet found. Run `npx omniology-init` to set one up.");
    return;
  }
  const kp = loadKeypair(path);
  const address = kp.publicKey.toBase58();
  let agentId = "—";
  let displayName = "—";
  if (existsSync(agentPath())) {
    try {
      const rec = JSON.parse(readFileSync(agentPath(), "utf8")) as AgentRecord;
      agentId = rec.agent_id ?? "—";
      displayName = rec.display_name ?? "—";
    } catch {
      /* unreadable agent.json → show wallet only */
    }
  }
  const connection = new Connection(opts.rpcUrl, "confirmed");
  const b = await getBalances(connection, kp.publicKey);
  box([
    c.bold("Active Omniology agent"),
    "",
    `Name:     ${displayName}`,
    `Agent ID: ${agentId}`,
    `Wallet:   ${address}`,
    `Balance:  ${c.green(b.usdc.toFixed(2) + " USDC")} / ${b.sol.toFixed(4)} SOL`,
    c.dim(`Keypair:  ${path}`),
  ]);
}

// ── Reset (--reset) — balance-checked, confirmed, backed up ────────────────────
async function performReset(opts: Options): Promise<void> {
  const dir = omniologyDir();
  if (!existsSync(dir)) {
    info("Nothing to reset.");
    return;
  }
  const existing = await inspectExistingWallet(keypairPath(), opts.rpcUrl, loadKeypair);
  if (existing?.hasFunds) {
    const proceed = await confirmDestructive(
      opts,
      c.yellow("⚠️  This wallet still holds funds:") +
        `\n  ${existing.address}\n` +
        `  ${existing.balances.usdc.toFixed(2)} USDC / ${existing.balances.sol.toFixed(4)} SOL\n` +
        c.bold("--reset erases its private key. Those funds become unrecoverable."),
    );
    if (!proceed) {
      if (!interactive) {
        fail(
          "Refusing to --reset a funded wallet without confirmation. " +
            "Re-run with --yes to proceed, or move the funds out first with " +
            "`npx omniology-init --withdraw --to=<your_address>`.",
        );
      }
      info("Reset cancelled — your wallet is untouched.");
      process.exit(0);
    }
  }
  const bak = backupOmniologyDir();
  if (bak) info(`Backed up previous setup → ${bak}`);
  rmSync(dir, { recursive: true, force: true });
  ok(`Reset: removed ${dir}`);
}

// ── Gated onboarding (v1.4.0) helpers ─────────────────────────────────────────

/** Resolve the enabled-tracks list from --tracks ("all" or a CSV). */
function resolveTracks(raw?: string): string[] {
  if (!raw || raw.toLowerCase() === "all") return [...ALL_TRACKS];
  const picked = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => (ALL_TRACKS as readonly string[]).includes(s));
  return picked.length ? picked : [...ALL_TRACKS];
}

/** Map the gate-6 flags to a choice. Gate 6 is OPT-IN: no flags → prompt (ask). */
function resolveGate6(opts: Options): Gate6Choice {
  if (opts.defaults || opts.noLimits) return { mode: "no_limits" };
  if (opts.dailyCap !== undefined || opts.perEntryCap !== undefined || opts.tracks !== undefined) {
    return {
      mode: "limits",
      limits: {
        daily_cap_usdc: opts.dailyCap ?? DEFAULT_DAILY_CAP_USDC,
        per_entry_cap_usdc: opts.perEntryCap ?? DEFAULT_PER_ENTRY_CAP_USDC,
        enabled_tracks: resolveTracks(opts.tracks),
      },
    };
  }
  return { mode: "ask" };
}

/** An existing, completed setup = a saved keypair + a registered agent.json. */
function detectExistingSetup(): AgentRecord | null {
  if (!existsSync(keypairPath()) || !existsSync(agentPath())) return null;
  try {
    const rec = JSON.parse(readFileSync(agentPath(), "utf8")) as AgentRecord;
    return rec.agent_id ? rec : null;
  } catch {
    return null;
  }
}

/** Save an --import keypair (funded-wallet-guarded) so gate 5 signs with it. */
async function importKeypair(opts: Options, kp: Keypair): Promise<void> {
  const path = keypairPath();
  await guardOverwrite(opts, path, kp.publicKey.toBase58());
  saveKeypair(path, kp);
  ok(`Imported wallet ${kp.publicKey.toBase58().slice(0, 8)}… → ${path}`);
}

/** Persist ~/.omniology/agent.json so --whoami / --reconfigure keep working. */
function writeAgentJson(agentId: string, walletAddress: string | undefined, email: string): void {
  const wallet =
    walletAddress ?? (existsSync(keypairPath()) ? loadKeypair(keypairPath()).publicKey.toBase58() : "");
  const record: AgentRecord = {
    agent_id: agentId,
    wallet_address: wallet,
    email: email || undefined,
    registered_at: new Date().toISOString(),
    network: "mainnet",
  };
  writeConfigAtomic(agentPath(), record as unknown as Record<string, unknown>);
}

/** The default flow: run gates 1–6, then connect the MCP host. */
async function runSetup(opts: Options, importedKp?: Keypair): Promise<void> {
  const surface = await resolveSurface(opts);

  // Importing a key? Save it first (guarded) so gate 5 signs with it.
  if (importedKp) await importKeypair(opts, importedKp);

  // Existing, completed setup → keep working untouched: skip the gates and just
  // (re)connect the host. --resume forces the gate flow instead.
  const existingAgent = detectExistingSetup();
  if (existingAgent && !opts.resume) {
    const w = existsSync(keypairPath()) ? loadKeypair(keypairPath()).publicKey.toBase58() : "";
    info(`Existing agent detected — reusing it (agent ${existingAgent.agent_id.slice(0, 8)}…, wallet ${w.slice(0, 8)}…). No new agent created.`);
    info("(Use --reset to start over, or --reconfigure to just refresh the host connector.)");
    const launch = resolveHostLaunch();
    const ctx = { keypairPath: keypairPath(), agentId: existingAgent.agent_id, opts, launch };
    const result = await installSurface(surface, ctx);
    const setupPath = writeSetupDoc(ctx);
    info(`Universal setup (any host): ${setupPath}`);
    completionBox(DASHBOARD_URL, result.openHint);
    return;
  }

  // Gate-2 password from stdin (scripted runs never pass it on the command line).
  let password: string | undefined;
  if (opts.passwordStdin) {
    password = await readStdin();
    if (!password) fail("--password-stdin was set but no password was received on stdin.");
  }

  let gateResult;
  try {
    gateResult = await runOnboarding({
      email: opts.email,
      password,
      username: opts.username ?? opts.displayName,
      acceptTos: opts.acceptTos,
      resume: opts.resume,
      capUsdc: opts.capUsdc,
      gate6: resolveGate6(opts),
      rpcUrl: opts.rpcUrl,
      skipFunding: opts.skipFunding,
      minSol: opts.minSol,
      minUsdc: opts.minUsdc,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), err, opts.debug);
  }

  const agentId = gateResult.agentId ?? detectExistingSetup()?.agent_id;
  if (!agentId) {
    fail(
      "Onboarding isn't finished yet (no agent connected). If your Balance isn't funded, fund it and re-run with --resume.",
    );
  }
  writeAgentJson(agentId, gateResult.walletAddress, gateResult.email);

  info("Connecting Omniology to your AI host…");
  const launch = resolveHostLaunch();
  const ctx = { keypairPath: keypairPath(), agentId, opts, launch };
  const result = await installSurface(surface, ctx);
  const setupPath = writeSetupDoc(ctx);
  info(`Universal setup (any host, incl. hand-built): ${setupPath}`);
  completionBox(DASHBOARD_URL, result.openHint);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP_TEXT);
    return;
  }

  banner();

  // Whoami mode: print the active agent + wallet + balance, then exit.
  if (opts.whoami) {
    await runWhoami(opts);
    return;
  }

  // Verify mode: is the agent wired up + ready to compete (or the exact blocker)?
  if (opts.verify) {
    const ready = await runVerify();
    process.exit(ready ? 0 : 1);
  }

  // Withdraw mode: move USDC out using the existing wallet, no setup flow.
  if (opts.withdraw) {
    await runWithdraw(opts);
    return;
  }

  // Reconfigure mode: re-run only the MCP install at @latest, no prompts.
  if (opts.reconfigure) {
    await runReconfigure(opts);
    return;
  }

  // Read the --import keypair into memory BEFORE any reset. `--reset --import`
  // used to delete ~/.omniology (and the import source inside it) first, then
  // ENOENT on read → an empty new wallet, funds stranded. Load it up front.
  let importedKp: Keypair | undefined;
  if (opts.importPath) {
    try {
      importedKp = loadKeypair(opts.importPath);
    } catch (err) {
      fail(
        `Couldn't read the keypair to --import at ${opts.importPath}: ` +
          (err instanceof Error ? err.message : String(err)),
        err,
        opts.debug,
      );
    }
  }

  if (opts.reset) {
    await performReset(opts);
  }

  await runSetup(opts, importedKp);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), err, process.argv.includes("--debug"));
});
