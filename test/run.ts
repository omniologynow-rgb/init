/* Unit tests for @omniology/init v0.2.0. Run: npm run test:unit */
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createApproveCheckedInstruction } from "@solana/spl-token";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideOverwrite, backupOmniologyDir, type WalletStatus } from "../src/safety.js";
import { cursorConfigPath, type PlatformEnv } from "../src/hosts.js";
import { mcpConfigMerge, mcpConfigUpsert, hasOmniologyServer, readConfig, toPortablePath, globalBinaryInstalled, resolveLaunch, npxLaunch, binaryLaunch } from "../src/config.js";
import { buildOpenclawAddArgs, openclawAddCommand, install as installOpenclaw } from "../src/surfaces/openclaw.js";
import { renderSetupDoc } from "../src/setup-doc.js";
import { discoverAgents, readConfiguredAgentIds, identityMismatches, type DiscoverDeps } from "../src/agents.js";
import { decideReadiness } from "../src/verify.js";
import { meetsThreshold, pollUntilFunded } from "../src/funding.js";
import { buildRegisterProof } from "../src/register.js";
import { parseArgs } from "../src/flags.js";
import { generateDisplayName } from "../src/names.js";
import { detectSurfaces, claudeCodeInstalled } from "../src/surfaces/detect.js";
import { buildAddArgs, install as installClaudeCode, claudeAddCommand } from "../src/surfaces/claude-code.js";
import { install as installCursor } from "../src/surfaces/cursor.js";
import type { Exec, ExecResult } from "../src/surfaces/types.js";
import { VAULT_AUTHORITY_PINNED, USDC_MINT } from "../src/constants.js";
import { assertPinnedDelegate, extractApproveDelegate, DelegateGuardError } from "../src/onboarding/tx-guard.js";
import { firstIncompleteGate, type OnboardStatus } from "../src/onboarding/gates.js";
import { OnboardApiError, type OnboardApi, type Gate6Payload } from "../src/onboarding/api.js";
import { runGates, passwordPolicyReason, suggestUsernames, type OnboardIo, type WalletGate, type GateDeps, type OnboardInputs } from "../src/onboarding/flow.js";

let passed = 0, failed = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? " — " + d : ""}`); }
};
const section = (t: string) => console.log(`\n=== ${t} ===`);
const fakeExec = (map: Record<string, Partial<ExecResult>>): Exec => (cmd, args) => {
  const key = `${cmd} ${args.join(" ")}`;
  for (const k of Object.keys(map)) if (key.includes(k)) return { status: 0, stdout: "", stderr: "", spawnError: false, ...map[k] };
  return { status: 1, stdout: "", stderr: "", spawnError: false };
};

section("portable path (Windows backslash fix)");
check("backslashes → forward slashes", toPortablePath("C:\\Users\\bro\\.omniology\\keypair.json") === "C:/Users/bro/.omniology/keypair.json");
check("posix path unchanged", toPortablePath("/home/bro/.omniology/keypair.json") === "/home/bro/.omniology/keypair.json");

section("surface detection");
{
  const p: PlatformEnv = { platform: "linux", home: "/home/bro", env: {} };
  const withClaude = detectSurfaces(p, fakeExec({ "claude --version": { status: 0 } }));
  const cc = withClaude.find((s) => s.id === "claude-code")!;
  check("claude-code detected when CLI returns 0", cc.installed && cc.recommended === true);
  check("manual is always available", withClaude.find((s) => s.id === "manual")!.installed);
  check("6 surfaces presented (incl. openclaw)", withClaude.length === 6);
  check("openclaw surface present", !!withClaude.find((s) => s.id === "openclaw"));
  const noClaude = detectSurfaces(p, fakeExec({ "claude --version": { spawnError: true, status: null } }));
  check("claude-code not installed when CLI missing", noClaude.find((s) => s.id === "claude-code")!.installed === false);
  check("claudeCodeInstalled true on status 0", claudeCodeInstalled(fakeExec({ "claude --version": { status: 0 } })));
  check("claudeCodeInstalled false on spawnError", claudeCodeInstalled(fakeExec({ "claude --version": { spawnError: true } })) === false);
}

section("claude code: add args");
{
  const args = buildAddArgs("C:\\Users\\bro\\.omniology\\keypair.json", "agent-uuid-1");
  check("adds omniology at user scope", args.includes("omniology") && args.includes("--scope") && args.includes("user"));
  check("keypair env uses forward slashes", args.includes("OMNIOLOGY_KEYPAIR_PATH=C:/Users/bro/.omniology/keypair.json"));
  check("agent id env present", args.includes("OMNIOLOGY_AGENT_ID=agent-uuid-1"));
  check("uses @latest after the -- separator", args.indexOf("--") < args.indexOf("@omniology/mcp-server@latest"));
  check("human command string is well-formed", /claude mcp add omniology --scope user .* -- npx -y @omniology\/mcp-server@latest/.test(claudeAddCommand({ keypairPath: "/k", agentId: "a", opts: {} as never })));
}

section("claude code: install (mocked exec)");
{
  const ctx = { keypairPath: "/home/bro/.omniology/keypair.json", agentId: "a-1", opts: {} as never };
  const okExec = fakeExec({ "mcp add": { status: 0, stdout: "Added stdio MCP server omniology" }, "mcp list": { status: 0, stdout: "omniology: npx -y @omniology/mcp-server@2.0.0 - Connected" } });
  const r1 = await installClaudeCode(ctx, okExec);
  check("install ok + verified when add succeeds and list shows it", r1.ok && r1.verified === true);

  const existsExec = fakeExec({ "mcp add": { status: 1, stderr: "MCP server omniology already exists" }, "mcp list": { status: 0, stdout: "omniology: ... Connected" } });
  const r2 = await installClaudeCode(ctx, existsExec);
  check("already-exists is treated as ok", r2.ok && r2.verified === true);

  const noClaude = fakeExec({ "mcp add": { spawnError: true, status: null } });
  const r3 = await installClaudeCode(ctx, noClaude);
  check("missing claude CLI → ok:false, verified:null (prints manual command)", r3.ok === false && r3.verified === null);
}

section("cursor install preserves existing entries (temp file)");
{
  const dir = mkdtempSync(join(tmpdir(), "omni-cursor-"));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } } }));
  const ctx = { keypairPath: "C:\\Users\\bro\\.omniology\\keypair.json", agentId: "agent-xyz", opts: {} as never };
  const r = await installCursor(ctx, cfg);
  const back = JSON.parse(readFileSync(cfg, "utf8"));
  check("cursor install ok + verified", r.ok && r.verified === true);
  check("preserved existing filesystem server", !!back.mcpServers.filesystem);
  check("added omniology with forward-slash keypair path", back.mcpServers.omniology.env.OMNIOLOGY_KEYPAIR_PATH === "C:/Users/bro/.omniology/keypair.json");
  check("added omniology with agent id", back.mcpServers.omniology.env.OMNIOLOGY_AGENT_ID === "agent-xyz");
  check("uses @latest", back.mcpServers.omniology.args.join(" ").includes("@omniology/mcp-server@latest"));
  // idempotency
  const r2 = await installCursor(ctx, cfg);
  check("re-run detects already-present", r2.ok && r2.verified === true);
}

section("config merge + portable (retained)");
{
  const env = { OMNIOLOGY_KEYPAIR_PATH: "C:/Users/bro/.omniology/keypair.json", OMNIOLOGY_AGENT_ID: "id-1" };
  const m = mcpConfigMerge({ mcpServers: { other: { command: "x" } }, top: 1 }, env);
  check("preserves other server + top key", !!(m.config.mcpServers as Record<string, unknown>).other && m.config.top === 1);
  check("detects existing by url", hasOmniologyServer({ mcpServers: { x: { url: "https://omniology-engine.fly.dev/mcp" } } }));
  check("missing file → {}", JSON.stringify(readConfig("/no/such.json")) === "{}");
}

section("Windows-robust launch resolution");
{
  const env = { OMNIOLOGY_KEYPAIR_PATH: "C:/k.json", OMNIOLOGY_AGENT_ID: "id-1" };
  const nlsInstalled = fakeExec({ "npm ls -g --depth=0 @omniology/mcp-server": { status: 0, stdout: "/usr/lib\n└── @omniology/mcp-server@2.2.5" } });
  const nlsMissing = fakeExec({ "npm ls -g": { status: 1, stdout: "" } });
  check("globalBinaryInstalled true when npm ls -g lists it", globalBinaryInstalled(nlsInstalled));
  check("globalBinaryInstalled false when absent", globalBinaryInstalled(nlsMissing) === false);
  check("resolveLaunch → binary when installed", resolveLaunch(nlsInstalled).command === "omniology-mcp");
  check("resolveLaunch → npx when not installed (no ensure)", resolveLaunch(nlsMissing).command === "npx");
  // ensure installs then re-checks: first ls fails, install ok, second ls succeeds
  let lsCalls = 0;
  const ensureExec: Exec = (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key.startsWith("npm ls -g")) return { status: lsCalls++ === 0 ? 1 : 0, stdout: lsCalls > 1 ? "@omniology/mcp-server@2.2.5" : "", stderr: "", spawnError: false };
    if (key.startsWith("npm i -g")) return { status: 0, stdout: "", stderr: "", spawnError: false };
    return { status: 1, stdout: "", stderr: "", spawnError: false };
  };
  check("resolveLaunch ensure installs then uses binary", resolveLaunch(ensureExec, { ensure: true }).command === "omniology-mcp");
  // the binary launch has no args; npx carries -y @latest
  check("binaryLaunch has empty args", binaryLaunch().args.length === 0);
  check("npxLaunch carries @latest", npxLaunch().args.join(" ").includes("@omniology/mcp-server@latest"));
  // config writers honor the chosen launch
  const merged = mcpConfigMerge({}, env, binaryLaunch());
  const srv = (merged.config.mcpServers as Record<string, { command: string; args: string[] }>).omniology!;
  check("merge writes binary command when binaryLaunch given", srv.command === "omniology-mcp" && srv.args.length === 0);
}

section("openclaw surface");
{
  const args = buildOpenclawAddArgs("C:\\Users\\bro\\.omniology\\keypair.json", "agent-9", npxLaunch());
  check("openclaw add uses mcp add omniology", args[0] === "mcp" && args[1] === "add" && args[2] === "omniology");
  check("openclaw passes --command", args.includes("--command") && args.includes("npx"));
  check("openclaw passes npx args as --arg", args.filter((a) => a === "--arg").length === 2);
  check("openclaw keypair env forward-slashed", args.includes("OMNIOLOGY_KEYPAIR_PATH=C:/Users/bro/.omniology/keypair.json"));
  const binArgs = buildOpenclawAddArgs("/k.json", "a", binaryLaunch());
  check("openclaw binary launch has no --arg", !binArgs.includes("--arg") && binArgs.includes("omniology-mcp"));
  check("openclaw command string well-formed", /openclaw mcp add omniology --command/.test(openclawAddCommand({ keypairPath: "/k", agentId: "a", opts: {} as never, launch: npxLaunch() })));

  const ctx = { keypairPath: "/home/bro/.omniology/keypair.json", agentId: "a-1", opts: {} as never, launch: npxLaunch() };
  const okExec = fakeExec({ "mcp add omniology": { status: 0, stdout: "added omniology" }, "mcp list": { status: 0, stdout: "omniology (stdio)" } });
  const r1 = await installOpenclaw(ctx, okExec);
  check("openclaw install ok + verified", r1.ok && r1.verified === true);
  const noCli = fakeExec({ "mcp add omniology": { spawnError: true, status: null } });
  const r2 = await installOpenclaw(ctx, noCli);
  check("openclaw missing CLI → ok:false, verified:null (prints command)", r2.ok === false && r2.verified === null);
}

section("universal SETUP.md");
{
  const ctx = { keypairPath: "/home/bro/.omniology/keypair.json", agentId: "agent-42", opts: {} as never, launch: binaryLaunch() };
  const doc = renderSetupDoc(ctx);
  check("SETUP.md names the agent id", doc.includes("agent-42"));
  check("SETUP.md has the 3-call compete loop", doc.includes("list_active_contests") && doc.includes("submit_entry") && doc.includes("check_payout"));
  check("SETUP.md forbids hand-signing", doc.includes("sign anything yourself") || doc.includes("never build or sign"));
  check("SETUP.md reflects the chosen launch (omniology-mcp)", doc.includes("omniology-mcp"));
  check("SETUP.md includes the openclaw CLI path", doc.includes("openclaw mcp add"));
  check("SETUP.md uses Connect ID vocab (no 'Agent ID' label)", doc.includes("Connect ID") && !doc.includes("Agent ID:"));
  check("SETUP.md has no user-facing 'wallet' copy", !/wallet/i.test(doc.replace(/no wallet strings/gi, "")));
}

section("device-agent discovery (P4)");
{
  // Fake fs: active slot has agent A; two archived backups (B, and A again).
  const files: Record<string, string> = {
    "/home/bro/.omniology/keypair.json": "[1,2,3]",
    "/home/bro/.omniology/agent.json": JSON.stringify({ agent_id: "A-id", display_name: "Alpha", wallet_address: "AAAwallet" }),
    "/home/bro/.omniology.bak/2026-07-20/keypair.json": "[4,5,6]",
    "/home/bro/.omniology.bak/2026-07-20/agent.json": JSON.stringify({ agent_id: "B-id", display_name: "Bravo", wallet_address: "BBBwallet" }),
    "/home/bro/.omniology.bak/2026-07-19/keypair.json": "[7,8,9]",
    "/home/bro/.omniology.bak/2026-07-19/agent.json": JSON.stringify({ agent_id: "A-id", display_name: "Alpha (old)", wallet_address: "AAAwallet" }),
  };
  const norm = (p: string) => p.replace(/\\/g, "/"); // node:path.join uses \ on Windows
  const deps: DiscoverDeps = {
    activeDir: "/home/bro/.omniology",
    bakRoot: "/home/bro/.omniology.bak",
    exists: (p) => { const n = norm(p); return n === "/home/bro/.omniology.bak" || n === "/home/bro/.omniology" || n in files; },
    readJson: (p) => (files[norm(p)] ? JSON.parse(files[norm(p)]!) : null),
    listDir: (p) => (norm(p) === "/home/bro/.omniology.bak" ? ["2026-07-19", "2026-07-20"] : []),
  };
  const found = discoverAgents(deps);
  check("discovers both distinct agents (deduped by id)", found.length === 2);
  check("active agent A is present and marked active", found.some((a) => a.agentId === "A-id" && a.source === "active"));
  check("archived agent B is present and marked archived", found.some((a) => a.agentId === "B-id" && a.source === "archived"));
  check("active copy wins over archived copy of the same id", found.find((a) => a.agentId === "A-id")!.source === "active");
  check("carries name + wallet + keypair path", found.find((a) => a.agentId === "B-id")!.name === "Bravo" && found.find((a) => a.agentId === "B-id")!.keypairPath.replace(/\\/g, "/").includes("2026-07-20"));

  // No agents on a clean device.
  const empty: DiscoverDeps = { ...deps, exists: () => false, readJson: () => null, listDir: () => [] };
  check("no agents on a clean device", discoverAgents(empty).length === 0);

  // Malformed agent.json (no agent_id) is skipped.
  const badFiles: Record<string, string> = {
    "/home/bro/.omniology/keypair.json": "[1]",
    "/home/bro/.omniology/agent.json": JSON.stringify({ display_name: "no id" }),
  };
  const badDeps: DiscoverDeps = {
    activeDir: "/home/bro/.omniology", bakRoot: "/home/bro/.omniology.bak",
    exists: (p) => p in badFiles, readJson: (p) => (badFiles[p] ? JSON.parse(badFiles[p]!) : null), listDir: () => [],
  };
  check("skips agent.json with no agent_id", discoverAgents(badDeps).length === 0);
}

section("identity reconcile (host config vs local)");
{
  const cfg = {
    "/h/.cursor/mcp.json": JSON.stringify({ mcpServers: { omniology: { command: "npx", env: { OMNIOLOGY_AGENT_ID: "AAA-id", OMNIOLOGY_KEYPAIR_PATH: "/k" } } } }),
    "/h/.openclaw/openclaw.json": JSON.stringify({ mcp: { servers: { omniology: { command: "omniology-mcp", env: { OMNIOLOGY_AGENT_ID: "BBB-id" } } } } }),
    "/h/no-omni.json": JSON.stringify({ mcpServers: { other: { command: "x" } } }),
  } as Record<string, string>;
  const deps = {
    sources: [
      { surface: "cursor", path: "/h/.cursor/mcp.json" },
      { surface: "openclaw", path: "/h/.openclaw/openclaw.json", nested: true },
      { surface: "cline", path: "/h/no-omni.json" },
      { surface: "missing", path: "/h/nope.json" },
    ],
    exists: (p: string) => p in cfg,
    readJson: (p: string) => (cfg[p] ? JSON.parse(cfg[p]!) : null),
  };
  const found = readConfiguredAgentIds(deps);
  check("reads flat mcpServers env id (cursor)", found.some((f) => f.surface === "cursor" && f.agentId === "AAA-id"));
  check("reads nested mcp.servers env id (openclaw)", found.some((f) => f.surface === "openclaw" && f.agentId === "BBB-id"));
  check("skips configs with no omniology entry", !found.some((f) => f.surface === "cline"));
  check("skips missing config files", !found.some((f) => f.surface === "missing"));

  check("mismatch detected when active differs", identityMismatches(found, "AAA-id").map((m) => m.agentId).join() === "BBB-id");
  check("no mismatch when all agree", identityMismatches([{ surface: "cursor", agentId: "Z", path: "/p" }], "Z").length === 0);
  check("no mismatch reported without an active identity", identityMismatches(found, undefined).length === 0);
}

section("device-agent flags (P4)");
{
  check("--agent parses", parseArgs(["--agent=abc123"]).agent === "abc123");
  check("--new parses", parseArgs(["--new"]).newAgent === true);
  check("picker flags default off", (() => { const o = parseArgs([]); return o.agent === undefined && o.newAgent === false; })());
}

section("--verify readiness (pure decision)");
{
  const W = "2dqiEjzf16XJiVr9cp5xzf5DfogqxbgiVAxP4hcLk5px";
  const agent = { agent_id: "3ce039b6-0000-0000-0000-000000000000", wallet_address: W };
  const readyR = decideReadiness(W, agent, { registered: true, signing_mode: "local_key", can_enter_contests: true, available_usdc: 1 });
  check("ready when can_enter_contests", readyR.ready && readyR.lines.some((l) => /READY/.test(l)));
  const blockedR = decideReadiness(W, agent, { registered: true, signing_mode: "local_key", can_enter_contests: false, blocking_reasons: ["EMAIL_NOT_VERIFIED", "INSUFFICIENT_USDC"], remediation: [{ reason: "INSUFFICIENT_USDC", action: "deposit", deposit_address: W, min_usdc: 0.01 }] });
  check("not ready lists email blocker", !blockedR.ready && blockedR.lines.some((l) => /Email not verified/.test(l)));
  check("not ready lists funding blocker w/ address", blockedR.lines.some((l) => l.includes(W) && /USDC/.test(l)));
  const mismatchR = decideReadiness("SomeOtherWalletPubkey1111111111111111111111", agent, null);
  check("mismatched local key → can't self-sign", !mismatchR.ready && mismatchR.lines.some((l) => /can't self-sign/.test(l)));
  const unreachR = decideReadiness(W, agent, null);
  check("unreachable engine → not ready, network hint", !unreachR.ready && unreachR.lines.some((l) => /Couldn't reach the engine/.test(l)));
}

section("funding + register + flags (retained)");
{
  check("threshold met", meetsThreshold({ sol: 0, usdc: 1 }, 0, 0.05));
  let n = 0;
  const r = await pollUntilFunded({} as never, Keypair.generate().publicKey, {
    minSol: 0, minUsdc: 0.05, pollMs: 1, timeoutMs: 10_000, now: () => n * 1000, sleep: async () => {}, read: async () => { n++; return { sol: 0, usdc: n >= 2 ? 1 : 0 }; },
  });
  check("poll resolves funded", r.funded);
  const kp = Keypair.generate();
  const proof = buildRegisterProof(kp, 1700000000);
  check("register proof verifies", ed25519.verify(bs58.decode(proof.signed_message), new TextEncoder().encode(proof.message_body), kp.publicKey.toBytes()));
  check("legacy --host=claude-desktop maps to claude-code", parseArgs(["--host=claude-desktop"]).host === "claude-code");
  check("--surface=cursor parses", parseArgs(["--surface=cursor"]).host === "cursor");
  check("default min-sol is 0", parseArgs([]).minSol === 0);
  let threw = false;
  try { parseArgs(["--surface=nope"]); } catch { threw = true; }
  check("rejects bad surface", threw);
  void cursorConfigPath;
}

section("v1.1.0 — display name + withdraw flags");
{
  const name = generateDisplayName(() => 0.5);
  check("display name format claude-{adj}-{noun}-{4digits}", /^claude-[a-z]+-[a-z]+-\d{4}$/.test(name), name);

  check("--name parses", parseArgs(["--name=duck-joker-9000"]).displayName === "duck-joker-9000");

  const w = parseArgs(["--withdraw", "--to=AbcDef", "--amount=2.5"]);
  check("--withdraw parses", w.withdraw === true && w.to === "AbcDef" && w.amount === 2.5);
  check("--withdraw without --amount = full balance (undefined)", parseArgs(["--withdraw", "--to=X"]).amount === undefined);

  let t1 = false;
  try { parseArgs(["--withdraw"]); } catch { t1 = true; }
  check("--withdraw requires --to", t1);
  let t2 = false;
  try { parseArgs(["--withdraw", "--to=X", "--amount=0"]); } catch { t2 = true; }
  check("--amount must be > 0", t2);
}

section("v1.2.0 — reconfigure (force overwrite to @latest)");
{
  check("--reconfigure parses", parseArgs(["--reconfigure"]).reconfigure === true);

  // upsert overwrites an existing (stale) omniology entry and preserves others.
  const env = { OMNIOLOGY_KEYPAIR_PATH: "/k.json", OMNIOLOGY_AGENT_ID: "a-9" };
  const existing = {
    mcpServers: {
      other: { command: "x" },
      omniology: { command: "npx", args: ["-y", "@omniology/mcp-server@2.0.0"], env: { OMNIOLOGY_AGENT_ID: "old" } },
    },
  };
  const up = mcpConfigUpsert(existing, env);
  const servers = up.mcpServers as Record<string, { args: string[]; env: Record<string, string> }>;
  const omni = servers.omniology!;
  check("upsert overwrites omniology to @latest", omni.args.join(" ").includes("@omniology/mcp-server@latest"));
  check("upsert refreshes agent id", omni.env.OMNIOLOGY_AGENT_ID === "a-9");
  check("upsert preserves other servers", !!(up.mcpServers as Record<string, unknown>).other);

  // cursor install with force overwrites even when omniology already present.
  const dir = mkdtempSync(join(tmpdir(), "omni-reconf-"));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { omniology: { command: "npx", args: ["-y", "@omniology/mcp-server@2.0.0"], env: {} } } }));
  const r = await installCursor({ keypairPath: "/k.json", agentId: "a-9", opts: {} as never, force: true }, cfg);
  const back = JSON.parse(readFileSync(cfg, "utf8"));
  check("force install updates existing entry to @latest", r.ok && back.mcpServers.omniology.args.join(" ").includes("@latest"));
}

section("v1.3.0 — wallet safety flags");
{
  check("--whoami parses", parseArgs(["--whoami"]).whoami === true);
  check("--force-overwrite parses", parseArgs(["--force-overwrite"]).forceOverwrite === true);
  check("--yes parses", parseArgs(["--yes"]).yes === true);
  check("-y is an alias for --yes", parseArgs(["-y"]).yes === true);
  // The #1 regression: --reset and --import are independently captured so main()
  // can read the import keypair BEFORE the reset wipes ~/.omniology.
  const both = parseArgs(["--reset", "--import=/tmp/key.json"]);
  check("--reset + --import both captured", both.reset === true && both.importPath === "/tmp/key.json");
  check("safety flags default false", (() => { const o = parseArgs([]); return !o.whoami && !o.forceOverwrite && !o.yes; })());
}

section("v1.3.0 — decideOverwrite (funded-wallet guard)");
{
  const funded: WalletStatus = { address: "WALLET_A", balances: { sol: 0.01, usdc: 5 }, hasFunds: true };
  const empty: WalletStatus = { address: "WALLET_A", balances: { sol: 0, usdc: 0 }, hasFunds: false };
  check("no existing wallet → proceed", decideOverwrite(null, "WALLET_B", false).action === "proceed");
  check("empty existing wallet → proceed", decideOverwrite(empty, "WALLET_B", false).action === "proceed");
  check("funded + different new key + no force → blocked", decideOverwrite(funded, "WALLET_B", false).action === "blocked");
  check("funded + re-import SAME key → proceed (no clobber)", decideOverwrite(funded, "WALLET_A", false).action === "proceed");
  check("funded + --force-overwrite → forced", decideOverwrite(funded, "WALLET_B", true).action === "forced");
  const blocked = decideOverwrite(funded, "WALLET_B", false);
  check("blocked carries the funded status for messaging", blocked.action === "blocked" && blocked.status.balances.usdc === 5);
}

section("v1.3.0 — backupOmniologyDir (backup-before-wipe)");
{
  const src = mkdtempSync(join(tmpdir(), "omni-src-"));
  const bakRoot = mkdtempSync(join(tmpdir(), "omni-bak-"));
  writeFileSync(join(src, "keypair.json"), "[1,2,3]");
  const dest = backupOmniologyDir(() => 1_700_000_000_000, src, bakRoot);
  check("backup returns a path", typeof dest === "string" && dest!.startsWith(bakRoot));
  check("backup copies the keypair", !!dest && existsSync(join(dest, "keypair.json")) && readFileSync(join(dest, "keypair.json"), "utf8") === "[1,2,3]");
  const missing = backupOmniologyDir(() => 1, join(tmpdir(), "omni-does-not-exist-zzz"), bakRoot);
  check("backup of missing dir → null", missing === null);
}

// ── v1.4.0 — gate-5 delegate guard (fail-closed) ─────────────────────────────
section("v1.4.0 — delegate guard (approve_checked)");
{
  // Build a real ApproveChecked tx toward a chosen delegate, serialized base64.
  const buildApproveB64 = (delegate: PublicKey): string => {
    const owner = Keypair.generate().publicKey;
    const ata = Keypair.generate().publicKey;
    const ix = createApproveCheckedInstruction(ata, new PublicKey(USDC_MINT), delegate, owner, 1_000_000n, 6);
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    tx.recentBlockhash = "11111111111111111111111111111111"; // 32 zero bytes → valid blockhash form
    return tx.serialize({ requireAllSignatures: false }).toString("base64");
  };

  const pinned = VAULT_AUTHORITY_PINNED;
  const goodTx = buildApproveB64(new PublicKey(pinned));
  const evilTx = buildApproveB64(Keypair.generate().publicKey);

  check("extracts the pinned delegate from a valid approve", extractApproveDelegate(goodTx) === pinned);
  let okPass = true;
  try { assertPinnedDelegate(goodTx, pinned, pinned); } catch { okPass = false; }
  check("accepts an approve toward the pinned vault authority", okPass);

  let rejectedWrongOnTx = false;
  try { assertPinnedDelegate(evilTx, pinned, pinned); } catch (e) { rejectedWrongOnTx = e instanceof DelegateGuardError; }
  check("REJECTS an approve whose on-tx delegate is not pinned", rejectedWrongOnTx);

  let rejectedWrongReported = false;
  try { assertPinnedDelegate(goodTx, "SomeOtherDelegate1111111111111111111111111", pinned); }
  catch (e) { rejectedWrongReported = e instanceof DelegateGuardError; }
  check("REJECTS when the server-reported delegate mismatches the pinned key", rejectedWrongReported);

  let rejectedGarbage = false;
  try { assertPinnedDelegate("not-base64-@@@", pinned, pinned); } catch (e) { rejectedGarbage = e instanceof DelegateGuardError; }
  check("REJECTS an undecodable transaction", rejectedGarbage);
}

// ── v1.4.0 — password policy + username suggestions (pure) ───────────────────
section("v1.4.0 — password policy + username suggestions");
{
  check("rejects short password", passwordPolicyReason("Ab1!") !== null);
  check("rejects missing symbol", passwordPolicyReason("Abcdef123456") !== null);
  check("accepts a strong password", passwordPolicyReason("Abcdef123!@#x") === null);
  const alts = suggestUsernames("cool guy!");
  check("suggests sanitized alternates", alts.length === 4 && alts[0] === "coolguy-1" && !alts.join("").includes(" "));
}

// ── v1.4.0 — gate-sequence state machine (mocked API) ────────────────────────
section("v1.4.0 — gate sequence state machine");
{
  const PINNED = VAULT_AUTHORITY_PINNED;
  // A valid approve tx toward the pinned delegate (so the in-flow guard passes).
  const approveB64 = (() => {
    const owner = Keypair.generate().publicKey;
    const ata = Keypair.generate().publicKey;
    const ix = createApproveCheckedInstruction(ata, new PublicKey(USDC_MINT), new PublicKey(PINNED), owner, 1_000_000n, 6);
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    tx.recentBlockhash = "11111111111111111111111111111111";
    return tx.serialize({ requireAllSignatures: false }).toString("base64");
  })();

  const statusAt = (currentGate: number, email = "a@b.com"): OnboardStatus => {
    const keys = ["gate_1_at", "gate_2_at", "gate_3_at", "gate_4_at", "gate_5_at", "gate_6_at"] as const;
    const gates: Record<string, string | null> = {
      gate_1_at: null, gate_2_at: null, gate_3_at: null, gate_4_at: null, gate_5_at: null, gate_6_at: null, completed_at: null,
    };
    for (let i = 1; i < currentGate; i++) gates[keys[i - 1]!] = "2026-01-01T00:00:00Z";
    return {
      email, gates: gates as unknown as OnboardStatus["gates"],
      current_gate: currentGate, wallet_type: null, pubkey: null, enrolled: false, just_completed: false,
    };
  };

  interface MockApiHandles { api: OnboardApi; calls: string[]; gate6: Gate6Payload[] }
  interface MockApiOpts {
    /** current_gate the /status read reports (drives resume). */
    statusGate?: number;
    /** mark the /status read as fully complete (completed_at set). */
    statusComplete?: boolean;
    /** current_gate the /resume login reports. */
    resumeGate?: number;
    /** gate 2 throws EMAIL_ALREADY_REGISTERED (existing account). */
    gate2Exists?: boolean;
  }
  const mockApi = (opts: MockApiOpts = {}): MockApiHandles => {
    const calls: string[] = [];
    const gate6: Gate6Payload[] = [];
    const rec = (n: string) => calls.push(n);
    const statusResult = (): OnboardStatus => {
      const s = statusAt(opts.statusGate ?? 1);
      if (opts.statusComplete) (s.gates as unknown as Record<string, string>)["completed_at"] = "2026-01-01T00:00:00Z";
      return s;
    };
    const api: OnboardApi = {
      async start() { rec("start"); return { session_id: "sess-1" }; },
      async gate1() { rec("gate1"); },
      async gate2() {
        rec("gate2");
        if (opts.gate2Exists) throw new OnboardApiError("exists", "EMAIL_ALREADY_REGISTERED", 409);
        return { onboarding_token: "tok-new" };
      },
      async resume() { rec("resume"); return { onboarding_token: "tok-r", status: statusAt(opts.resumeGate ?? 5) }; },
      async status() { rec("status"); return statusResult(); },
      async gate3Send() { rec("gate3Send"); return { already_verified: false, cooldown_seconds: 0 }; },
      async gate3Status() { rec("gate3Status"); return { verified: true }; },
      async gate3Confirm() { rec("gate3Confirm"); },
      async usernameAvailable() { rec("usernameAvailable"); return { available: true }; },
      async gate4(_t, u) { rec("gate4"); return { username: u }; },
      async gate5Local() { rec("gate5Local"); return { unsigned_transaction: approveB64, vault_authority: PINNED, agent_usdc_ata: "ata", cap_usdc: 5, engine_pays_network_fee: true }; },
      async gate5Confirm() { rec("gate5Confirm"); return { agent_id: "agent-123", remaining_usdc: 5 }; },
      async gate6(_t, p) { rec("gate6"); gate6.push(p); return { completed_at: "2026-01-01T00:00:10Z" }; },
    };
    return { api, calls, gate6 };
  };

  const mockIo = (opts: { confirm?: boolean } = {}): OnboardIo => ({
    interactive: true,
    step() {}, log() {}, ok() {}, warn() {}, info() {}, printTosSummary() {},
    async confirm() { return opts.confirm ?? false; },
    async ask(_q, def = "") { return def; },
    async askEmail() { return "a@b.com"; },
    async askPassword() { return "Abcdef123!@#x"; },
    async pollGate3(chk) { return chk(); },
  });

  const wallet: WalletGate = {
    async preparePubkey() { return "WalletPubkey1111111111111111111111111111111"; },
    async ensureFunded() {},
    async signAndBroadcast() { return "sig-abc"; },
  };

  const makeDeps = (api: OnboardApi, io: OnboardIo, initialState: GateDeps["initialState"] = null): GateDeps => ({
    api, io, wallet,
    pinnedDelegate: PINNED, tosVersion: "v-test",
    clock: { now: () => 0, sleep: async () => {} },
    saveState: () => {},
    initialState,
  });

  const baseInputs = (over: Partial<OnboardInputs> = {}): OnboardInputs => ({
    email: "a@b.com", password: "Abcdef123!@#x", username: "cooluser",
    acceptTos: true, resume: false, gate6: { mode: "ask" }, ...over,
  });

  // (a) Fresh flow drives gates 1→6 in order.
  {
    const m = mockApi();
    const r = await runGates(makeDeps(m.api, mockIo()), baseInputs());
    check("fresh flow calls gates in order", m.calls.join(",") === "start,gate1,gate2,gate3Send,gate3Status,usernameAvailable,gate4,gate5Local,gate5Confirm,gate6", m.calls.join(","));
    check("fresh flow returns the agent id", r.agentId === "agent-123");
    check("gate 6 opt-in default sends no_limits", JSON.stringify(m.gate6[0]) === JSON.stringify({ no_limits: true }));
  }

  // (b) Explicit yes at gate 6 sends the three values.
  {
    const m = mockApi();
    await runGates(makeDeps(m.api, mockIo({ confirm: true })), baseInputs({
      gate6: { mode: "limits", limits: { daily_cap_usdc: 2, per_entry_cap_usdc: 0.1, enabled_tracks: ["ART", "JOKE"] } },
    }));
    check("gate 6 limits payload forwarded verbatim", JSON.stringify(m.gate6[0]) === JSON.stringify({ daily_cap_usdc: 2, per_entry_cap_usdc: 0.1, enabled_tracks: ["ART", "JOKE"] }));
  }

  // (c) Resume with a valid token jumps to the first incomplete gate (4).
  {
    const m = mockApi({ statusGate: 4 });
    const r = await runGates(makeDeps(m.api, mockIo(), { email: "a@b.com", onboarding_token: "tok-x", valid: true }), baseInputs());
    check("resume skips completed gates 1-3", m.calls.join(",") === "status,usernameAvailable,gate4,gate5Local,gate5Confirm,gate6", m.calls.join(","));
    check("resume still completes with an agent id", r.agentId === "agent-123");
  }

  // (d) Email already registered at gate 2 → fall back to login, jump ahead.
  {
    const m = mockApi({ gate2Exists: true, resumeGate: 5 });
    const r = await runGates(makeDeps(m.api, mockIo()), baseInputs());
    check("email-exists at gate 2 triggers resume + jumps to gate 5", m.calls.join(",") === "start,gate1,gate2,resume,gate5Local,gate5Confirm,gate6", m.calls.join(","));
    check("email-exists path still yields an agent id", r.agentId === "agent-123");
  }

  // (e) A completed onboarding short-circuits (already complete).
  {
    const m = mockApi({ statusGate: 6, statusComplete: true });
    const r = await runGates(makeDeps(m.api, mockIo(), { email: "a@b.com", onboarding_token: "tok-x", valid: true }), baseInputs());
    check("already-complete status short-circuits", r.alreadyComplete === true && m.calls.join(",") === "status");
  }

  // firstIncompleteGate sanity (pure).
  check("firstIncompleteGate: fresh → 1", firstIncompleteGate(statusAt(1).gates) === 1);
  check("firstIncompleteGate: gates 1-5 done → 6", firstIncompleteGate(statusAt(6).gates) === 6);
}

// ── v1.4.0 — new flag parsing ────────────────────────────────────────────────
section("v1.4.0 — onboarding flags");
{
  check("--resume parses", parseArgs(["--resume"]).resume === true);
  check("--accept-tos parses", parseArgs(["--accept-tos"]).acceptTos === true);
  check("--password-stdin parses", parseArgs(["--password-stdin"]).passwordStdin === true);
  check("--username parses", parseArgs(["--username=coolbot"]).username === "coolbot");
  check("--defaults parses", parseArgs(["--defaults"]).defaults === true);
  check("--no-limits parses", parseArgs(["--no-limits"]).noLimits === true);
  check("--daily-cap parses", parseArgs(["--daily-cap=2.5"]).dailyCap === 2.5);
  check("--per-entry-cap parses", parseArgs(["--per-entry-cap=0.05"]).perEntryCap === 0.05);
  check("--tracks parses", parseArgs(["--tracks=ART,JOKE"]).tracks === "ART,JOKE");
  check("--cap-usdc parses", parseArgs(["--cap-usdc=10"]).capUsdc === 10);
  let t1 = false;
  try { parseArgs(["--daily-cap=0"]); } catch { t1 = true; }
  check("--daily-cap must be > 0", t1);
  let t2 = false;
  try { parseArgs(["--cap-usdc=-5"]); } catch { t2 = true; }
  check("--cap-usdc must be > 0", t2);
  check("onboarding flags default off", (() => { const o = parseArgs([]); return !o.resume && !o.acceptTos && !o.passwordStdin && !o.defaults && !o.noLimits; })());
}

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
