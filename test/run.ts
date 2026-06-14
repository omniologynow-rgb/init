/* Unit tests for @omniology/init pure logic. Run: npm run test:unit */
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { claudeDesktopConfigPath, cursorConfigPath, type PlatformEnv } from "../src/hosts.js";
import { mcpConfigMerge, hasOmniologyServer, readConfig } from "../src/config.js";
import { meetsThreshold, pollUntilFunded } from "../src/funding.js";
import { buildRegisterProof } from "../src/register.js";
import { parseArgs } from "../src/flags.js";

let passed = 0, failed = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? " — " + d : ""}`); }
};
const section = (t: string) => console.log(`\n=== ${t} ===`);

section("host config paths");
{
  const mac: PlatformEnv = { platform: "darwin", home: "/Users/bro", env: {} };
  const win: PlatformEnv = { platform: "win32", home: "C:\\Users\\bro", env: { APPDATA: "C:\\Users\\bro\\AppData\\Roaming" } };
  const lin: PlatformEnv = { platform: "linux", home: "/home/bro", env: {} };
  check("macOS Claude path", claudeDesktopConfigPath(mac).includes("Library/Application Support/Claude/claude_desktop_config.json"));
  check("Windows Claude path uses APPDATA", claudeDesktopConfigPath(win).includes("AppData") && claudeDesktopConfigPath(win).includes("Claude"));
  check("Linux Claude path", claudeDesktopConfigPath(lin).includes(".config/Claude/claude_desktop_config.json"));
  check("Cursor path", cursorConfigPath(mac).endsWith(".cursor/mcp.json"));
}

section("MCP config merge (must preserve existing servers)");
{
  const env = { OMNIOLOGY_KEYPAIR_PATH: "/home/bro/.omniology/keypair.json", OMNIOLOGY_AGENT_ID: "agent-123" };
  const existing = { mcpServers: { filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } }, otherTopKey: 7 };
  const { config, alreadyPresent } = mcpConfigMerge(existing, env);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  check("does not report already-present for a fresh config", alreadyPresent === false);
  check("preserves the existing 'filesystem' server", !!servers.filesystem);
  check("preserves unrelated top-level keys", config.otherTopKey === 7);
  check("adds 'omniology' server", !!servers.omniology);
  const omni = servers.omniology as { command: string; args: string[]; env: Record<string, string> };
  check("omniology uses npx @omniology/mcp-server", omni.command === "npx" && omni.args.join(" ").includes("@omniology/mcp-server"));
  check("omniology env has keypair path + agent id", omni.env.OMNIOLOGY_KEYPAIR_PATH === env.OMNIOLOGY_KEYPAIR_PATH && omni.env.OMNIOLOGY_AGENT_ID === "agent-123");

  // idempotency: running again detects the existing connector
  const second = mcpConfigMerge(config, env);
  check("second merge is a no-op (alreadyPresent)", second.alreadyPresent === true);

  // detect by URL too (manual/cowork-style entry)
  check("detects existing connector by engine URL", hasOmniologyServer({ mcpServers: { x: { url: "https://omniology-engine.fly.dev/mcp" } } }));
  check("empty config → not present", hasOmniologyServer({}) === false);
}

section("readConfig");
check("missing file → {}", JSON.stringify(readConfig("/no/such/file/xyz.json")) === "{}");

section("funding threshold + poll");
{
  check("meets when both ≥ thresholds", meetsThreshold({ sol: 0.01, usdc: 1 }, 0, 0.05));
  check("not met when USDC below", !meetsThreshold({ sol: 1, usdc: 0.01 }, 0, 0.05));

  // poll: funds appear on the 3rd read
  let n = 0;
  const fakeConn = {} as Connection;
  const owner = Keypair.generate().publicKey;
  const r = await pollUntilFunded(fakeConn, owner, {
    minSol: 0, minUsdc: 0.05, pollMs: 1, timeoutMs: 10_000,
    now: () => n * 1000,
    sleep: async () => { /* immediate */ },
    read: async () => { n++; return { sol: 0, usdc: n >= 3 ? 1 : 0 }; },
  });
  check("poll resolves funded once balance appears", r.funded && r.balances.usdc === 1, JSON.stringify(r));

  // poll: timeout when funds never arrive
  let t = 0;
  const r2 = await pollUntilFunded(fakeConn, owner, {
    minSol: 0, minUsdc: 0.05, pollMs: 1, timeoutMs: 5,
    now: () => (t += 3),
    sleep: async () => {},
    read: async () => ({ sol: 0, usdc: 0 }),
  });
  check("poll times out cleanly when never funded", r2.funded === false);
}

section("register proof");
{
  const kp = Keypair.generate();
  const proof = buildRegisterProof(kp, 1_700_000_000);
  check("message_body format", proof.message_body === `omniology-register-v1:${kp.publicKey.toBase58()}:1700000000`);
  check("signature verifies", ed25519.verify(bs58.decode(proof.signed_message), new TextEncoder().encode(proof.message_body), kp.publicKey.toBytes()));
  void PublicKey;
}

section("flags");
{
  const o = parseArgs(["--host=claude-desktop", "--min-usdc=0.1", "--skip-funding", "--email=a@b.co"]);
  check("parses host", o.host === "claude-desktop");
  check("parses min-usdc", o.minUsdc === 0.1);
  check("parses skip-funding", o.skipFunding === true);
  check("parses email", o.email === "a@b.co");
  let threw = false;
  try { parseArgs(["--host=nope"]); } catch { threw = true; }
  check("rejects bad host", threw);
  check("default min-sol is 0 (engine pays gas)", parseArgs([]).minSol === 0);
}

console.log(`\nSummary: passed ${passed}, failed ${failed}`);
process.exit(failed > 0 ? 1 : 0);
