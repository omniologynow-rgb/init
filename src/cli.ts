/**
 * omniology-init — one-command setup for an autonomous Omniology agent (v0.2.0).
 *
 * Flow: pick where to run (Claude Code recommended) → create/load wallet → fund
 * once (the only human action) → register → route the MCP install for that
 * surface → verify → print the exact prompt to paste. Plain English throughout.
 */
import { existsSync, rmSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { parseArgs, HELP_TEXT, type Options, type SurfaceId } from "./flags.js";
import { banner, box, step, ok, warn, info, arrow, c } from "./ui.js";
import { omniologyDir, keypairPath, agentPath, type AgentRecord } from "./paths.js";
import { writeConfigAtomic } from "./config.js";
import { detectSurfaces } from "./surfaces/detect.js";
import { installSurface } from "./surfaces/index.js";
import type { InstallResult } from "./surfaces/types.js";
import { generateKeypair, loadKeypair, saveKeypair, printAddressQr } from "./wallet.js";
import { pollUntilFunded } from "./funding.js";
import { registerAgent } from "./register.js";
import { withdraw } from "./withdraw.js";
import { generateDisplayName } from "./names.js";
import {
  DASHBOARD_URL,
  TERMS_URL,
  SUGGESTED_USDC,
  FUNDING_POLL_MS,
  FUNDING_TIMEOUT_MS,
} from "./constants.js";

const TOTAL_STEPS = 5;
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

function fail(message: string, debug?: unknown, debugOn = false): never {
  console.log("");
  console.log(`  ${c.red("✗")} ${c.bold(message)}`);
  if (debugOn && debug) console.error(debug);
  console.log("");
  process.exit(1);
}

/** Prominent SEND-USDC-(SOL-optional) banner shown above the funding QR. */
function printSolWarning(): void {
  const band = "══════════════════════════════════════════════════════";
  console.log("");
  console.log("  " + c.yellow(band));
  console.log("  " + c.bold(c.yellow("⚠️  IMPORTANT: SEND ")) + c.bold(c.green("USDC")) + c.bold(c.yellow(" TO COMPETE")));
  console.log("  " + c.yellow(band));
  console.log("  Your agent uses " + c.green("USDC") + " for contest entries — Omniology");
  console.log("  pays the Solana network fees while competing.");
  console.log("");
  console.log("  " + c.bold("OPTIONAL:") + " If you plan to later withdraw winnings to a");
  console.log("  personal wallet, send ~0.005 SOL too so your agent");
  console.log("  can pay the withdraw transaction fee. (Skip this if");
  console.log("  you'd rather keep winnings in your agent wallet for");
  console.log("  continued competing — no SOL needed for entries.)");
  console.log("  " + c.yellow(band));
}

// ── Step 1: where do you want to run your agent? ─────────────────────────────
async function resolveSurface(opts: Options): Promise<SurfaceId> {
  step(1, TOTAL_STEPS, "Where do you want to run your agent?");
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

// ── Step 2: wallet ───────────────────────────────────────────────────────────
async function resolveWallet(opts: Options): Promise<Keypair> {
  step(2, TOTAL_STEPS, "Setting up your agent wallet…");
  const path = keypairPath();

  if (opts.importPath) {
    const kp = loadKeypair(opts.importPath);
    saveKeypair(path, kp);
    ok(`Imported wallet ${kp.publicKey.toBase58().slice(0, 8)}… → ${path}`);
    return kp;
  }

  if (existsSync(path)) {
    const existing = loadKeypair(path);
    const choice = await ask(
      `A wallet already exists (${existing.publicKey.toBase58().slice(0, 8)}…). Use it or make a new one? [existing/fresh, default existing]: `,
      "existing",
    );
    if (choice.toLowerCase().startsWith("f")) {
      const kp = generateKeypair();
      saveKeypair(path, kp);
      ok(`New wallet created → ${path}`);
      return kp;
    }
    ok(`Using existing wallet ${existing.publicKey.toBase58().slice(0, 8)}…`);
    return existing;
  }

  const kp = generateKeypair();
  saveKeypair(path, kp);
  ok(`New wallet created → ${path}${process.platform !== "win32" ? " (private, chmod 600)" : ""}`);
  return kp;
}

// ── Step 3: funding ───────────────────────────────────────────────────────────
async function fundWallet(opts: Options, kp: Keypair): Promise<void> {
  step(3, TOTAL_STEPS, "Fund your wallet (the only thing you need to do)");
  const address = kp.publicKey.toBase58();
  printSolWarning();
  console.log("");
  console.log("  Send USDC (Solana) to this address:");
  console.log("");
  console.log("    " + c.bold(c.green(address)));
  console.log("");
  await printAddressQr(address);
  console.log(
    `  Suggested first deposit: ${c.bold(c.green(`${SUGGESTED_USDC} USDC`))} (a few contest entries).`,
  );

  if (opts.skipFunding) {
    warn("Skipping the funding check (--skip-funding). Fund the wallet before your agent enters contests.");
    return;
  }

  console.log("");
  info(`Waiting for funds… (checking every ${FUNDING_POLL_MS / 1000}s, Ctrl+C to stop)`);
  const connection = new Connection(opts.rpcUrl, "confirmed");
  let lastLine = "";
  const result = await pollUntilFunded(connection, new PublicKey(address), {
    minSol: opts.minSol,
    minUsdc: opts.minUsdc,
    pollMs: FUNDING_POLL_MS,
    timeoutMs: FUNDING_TIMEOUT_MS,
    onTick: (b) => {
      const line = `  …balance so far: ${b.usdc.toFixed(2)} USDC${opts.minSol > 0 ? ` / ${b.sol.toFixed(4)} SOL` : ""}`;
      if (line !== lastLine) { console.log(line); lastLine = line; }
    },
  });
  if (!result.funded) {
    fail(
      `Didn't see the funds within ${Math.round(FUNDING_TIMEOUT_MS / 60000)} minutes. ` +
        "No problem — fund the wallet whenever you like, then re-run this command (it'll pick up where you left off).",
    );
  }
  ok(`Detected ${result.balances.usdc.toFixed(2)} USDC. Ready.`);
}

// ── Step 4: register ───────────────────────────────────────────────────────────
async function register(opts: Options, kp: Keypair): Promise<AgentRecord> {
  step(4, TOTAL_STEPS, "Registering your agent with Omniology…");

  if (existsSync(agentPath())) {
    try {
      const rec = JSON.parse(readFileSync(agentPath(), "utf8")) as AgentRecord;
      if (rec.agent_id && rec.wallet_address === kp.publicKey.toBase58()) {
        ok(`Already registered — agent ${rec.agent_id.slice(0, 8)}…`);
        return rec;
      }
    } catch {
      /* re-register */
    }
  }

  let email = opts.email;
  if (!email) {
    email = await ask("Email for winnings + tax (1099) notices (required): ");
    while (interactive && (!email || !isEmail(email))) {
      email = await ask("  Please enter a valid email address: ");
    }
  }
  if (!email || !isEmail(email)) {
    fail("A valid email is required to register (Omniology sends payout + tax notices there). Re-run with --email=you@example.com.");
  }

  // Display name: flag → prompt (press ENTER to auto-generate) → auto-gen fallback.
  let displayName = opts.displayName;
  if (!displayName) {
    const suggested = generateDisplayName();
    const answer = await ask(
      `What should we call your agent? (e.g. 'duck-joker-9000'). Press ENTER for "${suggested}": `,
      suggested,
    );
    displayName = answer || suggested;
  }
  ok(`Agent name: ${displayName}`);

  info(`By continuing you accept the Terms of Service at ${TERMS_URL}.`);
  let res;
  try {
    res = await registerAgent(kp, { email, displayName });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), err, opts.debug);
  }

  const record: AgentRecord = {
    agent_id: res.agent_id,
    wallet_address: kp.publicKey.toBase58(),
    email,
    display_name: displayName,
    registered_at: new Date().toISOString(),
    network: "mainnet",
  };
  writeConfigAtomic(agentPath(), record as unknown as Record<string, unknown>);
  ok(`Registered! Agent ID ${res.agent_id.slice(0, 8)}… (saved to ${agentPath()})`);
  if (res.email_verification_sent) ok(`Verification email sent to ${email} — click the link when you can.`);
  return record;
}

function successBox(result: InstallResult): void {
  const lines: string[] = [c.bold(c.green("✓ Setup complete!")), ""];
  lines.push(result.openHint);
  lines.push("");
  lines.push("Then tell your agent:");
  lines.push(c.cyan('  "Compete in Omniology contests for me —'));
  lines.push(c.cyan('   keep playing until I tell you to stop."'));
  lines.push("");
  lines.push(c.dim(`Watch live: ${DASHBOARD_URL}`));
  box(lines);
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP_TEXT);
    return;
  }

  banner();

  // Withdraw mode: move USDC out using the existing wallet, no setup flow.
  if (opts.withdraw) {
    await runWithdraw(opts);
    return;
  }

  if (opts.reset) {
    if (existsSync(omniologyDir())) {
      rmSync(omniologyDir(), { recursive: true, force: true });
      ok(`Reset: removed ${omniologyDir()}`);
    } else {
      info("Nothing to reset.");
    }
  }

  const surface = await resolveSurface(opts);
  const kp = await resolveWallet(opts);
  await fundWallet(opts, kp);
  const agent = await register(opts, kp);

  step(5, TOTAL_STEPS, "Connecting Omniology to your agent…");
  const result = await installSurface(surface, {
    keypairPath: keypairPath(),
    agentId: agent.agent_id,
    opts,
  });

  successBox(result);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), err, process.argv.includes("--debug"));
});
