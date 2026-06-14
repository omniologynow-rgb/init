/**
 * omniology-init — one-command setup for an autonomous Omniology agent.
 *
 * 5 steps: detect host → create/load wallet → fund (the only human action) →
 * register → write host config. Plain English throughout; the only crypto the
 * user ever sees is a wallet address to send USDC to.
 */
import { existsSync, rmSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { parseArgs, HELP_TEXT, type Options } from "./flags.js";
import { banner, box, step, ok, warn, info, arrow, c } from "./ui.js";
import { omniologyDir, keypairPath, agentPath, type AgentRecord } from "./paths.js";
import {
  detectHosts,
  hostInfoFor,
  currentPlatform,
  type HostInfo,
} from "./hosts.js";
import {
  readConfig,
  mcpConfigMerge,
  writeConfigAtomic,
  manualConfigSnippet,
  type OmniologyServerEnv,
} from "./config.js";
import { generateKeypair, loadKeypair, saveKeypair, printAddressQr } from "./wallet.js";
import { pollUntilFunded } from "./funding.js";
import { registerAgent } from "./register.js";
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

// ── Step 1: host ────────────────────────────────────────────────────────────
async function resolveHost(opts: Options): Promise<HostInfo> {
  step(1, TOTAL_STEPS, "Detecting your AI host…");
  if (opts.host) {
    const info = hostInfoFor(opts.host);
    ok(`Using ${info.label} (from --host)`);
    return info;
  }
  const found = detectHosts();
  if (found.length === 0) {
    warn("No supported AI host detected — I'll print manual setup instructions at the end.");
    return hostInfoFor("manual");
  }
  if (found.length === 1) {
    ok(`Found: ${found[0]!.label}`);
    return found[0]!;
  }
  info(`Found ${found.length} hosts:`);
  found.forEach((h, i) => arrow(`${i + 1}. ${h.label}`));
  const pick = await ask(`Which one? [1-${found.length}, default 1]: `, "1");
  const idx = Math.min(Math.max(parseInt(pick, 10) || 1, 1), found.length) - 1;
  ok(`Using ${found[idx]!.label}`);
  return found[idx]!;
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
  console.log("");
  console.log("  Send USDC (Solana) to this address:");
  console.log("");
  console.log("    " + c.bold(c.green(address)));
  console.log("");
  await printAddressQr(address);
  console.log(
    `  Suggested first deposit: ${c.bold(`${SUGGESTED_USDC} USDC`)} (a few contest entries). ` +
      "You do NOT need SOL — Omniology pays the network fees.",
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

  // Reuse an existing registration if we already have one for this wallet.
  if (existsSync(agentPath())) {
    try {
      const rec = JSON.parse(readFileSync(agentPath(), "utf8")) as AgentRecord;
      if (rec.agent_id && rec.wallet_address === kp.publicKey.toBase58()) {
        ok(`Already registered — agent ${rec.agent_id.slice(0, 8)}…`);
        return rec;
      }
    } catch {
      /* fall through and re-register */
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

  info(`By continuing you accept the Terms of Service at ${TERMS_URL}.`);
  let res;
  try {
    res = await registerAgent(kp, { email, displayName: undefined });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), err, opts.debug);
  }

  const record: AgentRecord = {
    agent_id: res.agent_id,
    wallet_address: kp.publicKey.toBase58(),
    email,
    registered_at: new Date().toISOString(),
    network: "mainnet",
  };
  writeConfigAtomic(agentPath(), record as unknown as Record<string, unknown>);
  ok(`Registered! Agent ID ${res.agent_id.slice(0, 8)}… (saved to ${agentPath()})`);
  if (res.email_verification_sent) ok(`Verification email sent to ${email} — click the link when you can.`);
  return record;
}

// ── Step 5: configure host ──────────────────────────────────────────────────
function configureHost(host: HostInfo, kp: Keypair, agent: AgentRecord): { restartNeeded: boolean } {
  step(5, TOTAL_STEPS, `Configuring ${host.label}…`);
  const env: OmniologyServerEnv = {
    OMNIOLOGY_KEYPAIR_PATH: keypairPath(),
    OMNIOLOGY_AGENT_ID: agent.agent_id,
  };

  if (host.host === "cowork") {
    info("Cowork connects to Omniology over the web (it can't run the local signer).");
    arrow("In the chat panel: '+' → Connectors → Add Custom Connector");
    arrow("Name: omniology   URL: https://omniology-engine.fly.dev/mcp");
    info("If you already have the omniology connector, you're done — no action needed.");
    warn("Your wallet lives in this session. Save the keypair (or import it to Phantom) before the session ends.");
    info("For a persistent, fully-autonomous agent, run this on your own machine with Claude Desktop instead.");
    return { restartNeeded: false };
  }

  if (host.host === "manual" || !host.configPath) {
    info("Add this to your AI host's MCP config (it preserves any servers you already have):");
    console.log("");
    console.log(manualConfigSnippet(env).split("\n").map((l) => "    " + l).join("\n"));
    console.log("");
    return { restartNeeded: true };
  }

  let existing: Record<string, unknown>;
  try {
    existing = readConfig(host.configPath);
  } catch {
    warn(`Your ${host.label} config at ${host.configPath} isn't valid JSON, so I didn't touch it.`);
    info("Add this entry manually (under mcpServers):");
    console.log("");
    console.log(manualConfigSnippet(env).split("\n").map((l) => "    " + l).join("\n"));
    return { restartNeeded: true };
  }

  const merged = mcpConfigMerge(existing, env);
  if (merged.alreadyPresent) {
    ok("Omniology connector already configured — leaving it as-is.");
    info("No restart needed — it'll use your agent automatically.");
    return { restartNeeded: false };
  }
  writeConfigAtomic(host.configPath, merged.config);
  ok(`MCP config updated at ${host.configPath}`);
  ok("Your existing MCP servers were preserved.");
  return { restartNeeded: true };
}

function successBox(host: HostInfo, restartNeeded: boolean): void {
  const lines: string[] = [c.bold(c.green("✓ Setup complete!")), ""];
  if (restartNeeded) {
    if (host.host === "manual") lines.push("Add the config above, then restart your AI host.");
    else lines.push(`Restart ${host.label} to load Omniology.`);
  } else if (host.host === "cowork") {
    lines.push("Add the connector above (or open your current session).");
  } else {
    lines.push(`Open ${host.label} — you're ready.`);
  }
  lines.push("");
  lines.push("Then just tell your agent:");
  lines.push(c.cyan('  "Compete in Omniology contests for me —'));
  lines.push(c.cyan('   keep playing until I tell you to stop."'));
  lines.push("");
  lines.push(c.dim(`Watch live: ${DASHBOARD_URL}`));
  box(lines);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP_TEXT);
    return;
  }

  banner();

  if (opts.reset) {
    if (existsSync(omniologyDir())) {
      rmSync(omniologyDir(), { recursive: true, force: true });
      ok(`Reset: removed ${omniologyDir()}`);
    } else {
      info("Nothing to reset.");
    }
  }

  const host = await resolveHost(opts);
  const kp = await resolveWallet(opts);
  await fundWallet(opts, kp);
  const agent = await register(opts, kp);
  const { restartNeeded } = configureHost(host, kp, agent);
  successBox(host, restartNeeded);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err), err, process.argv.includes("--debug"));
});
