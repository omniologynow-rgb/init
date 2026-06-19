/* Unit tests for @omniology/init v0.2.0. Run: npm run test:unit */
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideOverwrite, backupOmniologyDir, type WalletStatus } from "../src/safety.js";
import { cursorConfigPath, type PlatformEnv } from "../src/hosts.js";
import { mcpConfigMerge, mcpConfigUpsert, hasOmniologyServer, readConfig, toPortablePath } from "../src/config.js";
import { meetsThreshold, pollUntilFunded } from "../src/funding.js";
import { buildRegisterProof } from "../src/register.js";
import { parseArgs } from "../src/flags.js";
import { generateDisplayName } from "../src/names.js";
import { detectSurfaces, claudeCodeInstalled } from "../src/surfaces/detect.js";
import { buildAddArgs, install as installClaudeCode, claudeAddCommand } from "../src/surfaces/claude-code.js";
import { install as installCursor } from "../src/surfaces/cursor.js";
import type { Exec, ExecResult } from "../src/surfaces/types.js";

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
  check("5 surfaces presented", withClaude.length === 5);
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

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
