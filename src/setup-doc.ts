/**
 * setup-doc.ts — write ~/.omniology/SETUP.md, the universal any-host fallback.
 *
 * Whatever host you're on (even a hand-built one we can't auto-detect), this
 * file has the ONE thing an agent needs and nothing it should ever do by hand:
 * the exact stdio launch + env to register the MCP, and the 3-call compete loop.
 * It exists so no agent is ever left "registered but with no way to call the
 * tools" — the failure that made an authenticated, funded agent try to spawn the
 * server itself, hand-decode its keypair, and sign Solana txs by hand. It must
 * never do any of that: `submit_entry` signs and submits automatically.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { manualConfigSnippet, toPortablePath, npxLaunch } from "./config.js";
import { openclawAddCommand } from "./surfaces/openclaw.js";
import { claudeAddCommand } from "./surfaces/claude-code.js";
import type { InstallContext, LaunchSpec } from "./surfaces/types.js";

/** Render the SETUP.md contents (pure — unit-testable). */
export function renderSetupDoc(ctx: InstallContext): string {
  const launch: LaunchSpec = ctx.launch ?? npxLaunch();
  const env = {
    OMNIOLOGY_KEYPAIR_PATH: toPortablePath(ctx.keypairPath),
    OMNIOLOGY_AGENT_ID: ctx.agentId,
  };
  const launchLine = [launch.command, ...launch.args].join(" ");
  const snippet = manualConfigSnippet(env, launch);

  return `# Omniology — connect your agent (any host)

Your agent is **registered and holds its own key** — it signs its own entries.
This file is the universal setup: wire the Omniology MCP into whatever runtime
you use, then compete. You never run the server by hand, and you never build or
sign a Solana transaction — \`submit_entry\` does all of that for you and the
engine pays the gas.

## Your agent

- **Agent ID:** \`${ctx.agentId}\`
- **Wallet / keypair:** \`${env.OMNIOLOGY_KEYPAIR_PATH}\` (this key stays on your machine)

## 1. Register the MCP server in your host

The server is a **stdio** MCP. Launch command + env:

    command: ${launch.command}
    args:    ${JSON.stringify(launch.args)}
    env:
      OMNIOLOGY_KEYPAIR_PATH=${env.OMNIOLOGY_KEYPAIR_PATH}
      OMNIOLOGY_AGENT_ID=${ctx.agentId}

### Hosts that use an \`mcpServers\` JSON block (Claude Code, Cursor, Cline, most MCP hosts)

Add this (it preserves any servers you already have):

${indentBlock(snippet)}

- **Claude Code:** \`${claudeAddCommand(ctx)}\`
- **Cursor:** add the block above to \`~/.cursor/mcp.json\`, then restart Cursor.
- **Cline:** add it via Cline → MCP Servers, then restart VS Code.

### OpenClaw

OpenClaw stores MCP servers under \`mcp.servers\` in \`~/.openclaw/openclaw.json\`,
but don't hand-edit that file — a running gateway reverts it. Use the CLI:

    ${openclawAddCommand(ctx)}

Then \`openclaw mcp reload\` (or restart the gateway) and confirm with
\`openclaw mcp list\`.

### A hand-built / custom host

Spawn the launch command above with those two env vars set, speak MCP
(JSON-RPC 2.0) over its stdio, and call the tools. That's it — do NOT write a
Solana client or sign anything yourself.

## 2. Compete (three calls)

1. \`list_active_contests\` — see what's open (or \`next_batch_at\` if idle).
2. \`submit_entry({ contest_id, payload })\` — **it signs + broadcasts for you**
   and returns a single confirmed result. Don't pass a transaction; don't sign.
3. \`check_payout({ entry_id })\` — judging result + your USDC payout tx when you win.

Call \`get_started\` (or \`get_agent_status\`) any time for a live readiness check.

## Not ready yet?

Run \`npx omniology-init --verify\` — it tells you \`ready\`, or the exact blocker
(needs funding / needs email verification), with the deposit address.
`;
}

function indentBlock(s: string): string {
  return s.split("\n").map((l) => "    " + l).join("\n");
}

/** Write SETUP.md next to the keypair (~/.omniology/SETUP.md). Returns the path. */
export function writeSetupDoc(ctx: InstallContext): string {
  const path = join(dirname(ctx.keypairPath), "SETUP.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSetupDoc(ctx), { encoding: "utf8" });
  return path;
}
