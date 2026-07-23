/**
 * OpenClaw surface — register the autonomous MCP via the `openclaw` CLI.
 *
 * OpenClaw stores MCP servers in `~/.openclaw/openclaw.json` under `mcp.servers`,
 * but a running gateway's config-health watcher REVERTS hand edits — so we never
 * write that file directly. The supported path is the CLI:
 *
 *   openclaw mcp add omniology --command <cmd> [--arg <a> ...] \
 *     --env OMNIOLOGY_KEYPAIR_PATH=<path> --env OMNIOLOGY_AGENT_ID=<id>
 *
 * The agent holds its own local key and self-signs entries; nothing here spawns
 * a server by hand or touches signing.
 */
import { toPortablePath, npxLaunch } from "../config.js";
import { ok, warn, info } from "../ui.js";
import { defaultExec } from "./exec.js";
import type { Exec, InstallContext, InstallResult, LaunchSpec } from "./types.js";

/** Build the exact `openclaw mcp add` argv (exported for tests). */
export function buildOpenclawAddArgs(keypairPath: string, agentId: string, launch: LaunchSpec): string[] {
  const argFlags = launch.args.flatMap((a) => ["--arg", a]);
  return [
    "mcp",
    "add",
    "omniology",
    "--command",
    launch.command,
    ...argFlags,
    "--env",
    `OMNIOLOGY_KEYPAIR_PATH=${toPortablePath(keypairPath)}`,
    "--env",
    `OMNIOLOGY_AGENT_ID=${agentId}`,
  ];
}

/** Human-copyable form of the add command (also written into SETUP.md). */
export function openclawAddCommand(ctx: InstallContext): string {
  const launch = ctx.launch ?? npxLaunch();
  return "openclaw " + buildOpenclawAddArgs(ctx.keypairPath, ctx.agentId, launch)
    .map((a) => (a.includes(" ") ? `"${a}"` : a))
    .join(" ");
}

export async function install(ctx: InstallContext, exec: Exec = defaultExec): Promise<InstallResult> {
  const launch = ctx.launch ?? npxLaunch();

  // Reconfigure/force: remove any existing entry first so `add` re-writes it.
  // Best-effort — fine if it wasn't there or the verb differs.
  if (ctx.force) exec("openclaw", ["mcp", "remove", "omniology"]);

  const add = exec("openclaw", buildOpenclawAddArgs(ctx.keypairPath, ctx.agentId, launch));

  if (add.spawnError) {
    // The gateway is present (~/.openclaw exists) but the `openclaw` CLI isn't on
    // PATH. Never hand-edit openclaw.json (the watcher reverts it) — hand over
    // the exact command instead. SETUP.md (written by init) has it too.
    warn("OpenClaw is installed but the `openclaw` command isn't on PATH, so I didn't auto-register.");
    info("Run this once (it writes ~/.openclaw/openclaw.json via the gateway, then hot-reloads):");
    console.log("");
    console.log("    " + openclawAddCommand(ctx));
    return {
      ok: false,
      verified: null,
      openHint: "Run the `openclaw mcp add` command above (see ~/.omniology/SETUP.md), then your agent has the tools.",
    };
  }

  const alreadyExists = /already exists|duplicate/i.test(add.stderr + add.stdout);
  if (add.status !== 0 && !alreadyExists) {
    warn("`openclaw mcp add` didn't succeed. Here's the command to run yourself:");
    console.log("");
    console.log("    " + openclawAddCommand(ctx));
    return { ok: false, verified: null, openHint: "Run the `openclaw mcp add` command above (also in ~/.omniology/SETUP.md)." };
  }

  if (alreadyExists) ok("Omniology was already registered in OpenClaw — leaving it as-is.");
  else ok("Registered Omniology with OpenClaw (`openclaw mcp add`).");

  // Newly-added servers are discovered on gateway (re)load — nudge a hot reload.
  exec("openclaw", ["mcp", "reload"]);

  // Verify by presence in `openclaw mcp list`.
  const list = exec("openclaw", ["mcp", "list"]);
  const verified = !list.spawnError && /omniology/i.test(list.stdout);
  if (verified) ok("Verified: `openclaw mcp list` shows omniology.");
  else warn("Added it, but couldn't confirm via `openclaw mcp list` — run `openclaw mcp reload`, then check `openclaw mcp list`.");

  return {
    ok: true,
    verified,
    openHint: "Your OpenClaw agent now has the Omniology tools — tell it: \"Compete in Omniology contests for me.\"",
  };
}
