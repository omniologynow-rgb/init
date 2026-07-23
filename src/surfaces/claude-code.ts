/**
 * Claude Code surface — the recommended home. Claude Code has native stdio MCP
 * support and runs host-native (no sandbox), so the autonomous signer can read
 * the local keypair. We register globally with `claude mcp add --scope user`.
 */
import { toPortablePath, npxLaunch } from "../config.js";
import { CLAUDE_DOWNLOAD_URL } from "../constants.js";
import { ok, warn, info } from "../ui.js";
import { manualConfigSnippet } from "../config.js";
import { defaultExec } from "./exec.js";
import type { Exec, InstallContext, InstallResult, LaunchSpec } from "./types.js";

/** Build the exact `claude mcp add` argv (exported for tests). */
export function buildAddArgs(keypairPath: string, agentId: string, launch: LaunchSpec = npxLaunch()): string[] {
  return [
    "mcp",
    "add",
    "omniology",
    "--scope",
    "user",
    "--env",
    `OMNIOLOGY_KEYPAIR_PATH=${toPortablePath(keypairPath)}`,
    "--env",
    `OMNIOLOGY_AGENT_ID=${agentId}`,
    "--",
    launch.command,
    ...launch.args,
  ];
}

export async function install(ctx: InstallContext, exec: Exec = defaultExec): Promise<InstallResult> {
  // Reconfigure: `claude mcp add` errors if the server already exists, so remove
  // it first to force a clean re-add at @latest. Ignore the result (it's fine if
  // it wasn't there).
  if (ctx.force) exec("claude", ["mcp", "remove", "omniology", "--scope", "user"]);

  const launch = ctx.launch ?? npxLaunch();
  const args = buildAddArgs(ctx.keypairPath, ctx.agentId, launch);
  const add = exec("claude", args);

  if (add.spawnError) {
    // Claude Code CLI isn't on PATH. Don't fail — give the exact command + manual config.
    warn("Couldn't find the `claude` command, so I didn't auto-configure Claude Code.");
    info("Install Claude Code from " + CLAUDE_DOWNLOAD_URL + " (Code tab), then run this once:");
    console.log("");
    console.log("    " + claudeAddCommand(ctx));
    return { ok: false, verified: null, openHint: `Install Claude Code (${CLAUDE_DOWNLOAD_URL}), then run the command above.` };
  }

  const alreadyExists = /already exists/i.test(add.stderr + add.stdout);
  if (add.status !== 0 && !alreadyExists) {
    warn("`claude mcp add` didn't succeed. Here's the command to run yourself:");
    console.log("");
    console.log("    " + claudeAddCommand(ctx));
    info("Or add this to your MCP config manually:");
    console.log(indent(manualConfigSnippet(envFor(ctx), launch)));
    return { ok: false, verified: null, openHint: "Run the `claude mcp add` command above, then open Claude Code." };
  }

  if (alreadyExists) ok("Omniology was already registered in Claude Code — leaving it as-is.");
  else ok("Registered Omniology with Claude Code (scope: user — available in every project).");

  // Verify by presence in `claude mcp list`.
  const list = exec("claude", ["mcp", "list"]);
  const verified = !list.spawnError && /omniology/i.test(list.stdout);
  if (verified) {
    ok("Verified: `claude mcp list` shows omniology.");
    if (/omniology[^\n]*pending/i.test(list.stdout)) {
      info("(It shows \"pending approval\" until you open Claude Code once and approve it — normal.)");
    }
  } else {
    warn("Couldn't confirm via `claude mcp list` — open Claude Code and check Settings → MCP. If it's missing, run:");
    console.log("    " + claudeAddCommand(ctx));
  }

  return {
    ok: true,
    verified,
    openHint: `Open Claude Code (${CLAUDE_DOWNLOAD_URL} → Code tab) and approve Omniology if prompted.`,
  };
}

function envFor(ctx: InstallContext) {
  return {
    OMNIOLOGY_KEYPAIR_PATH: toPortablePath(ctx.keypairPath),
    OMNIOLOGY_AGENT_ID: ctx.agentId,
  };
}

/** Human-copyable form of the add command. */
export function claudeAddCommand(ctx: InstallContext): string {
  const launch = ctx.launch ?? npxLaunch();
  return (
    `claude mcp add omniology --scope user ` +
    `--env OMNIOLOGY_KEYPAIR_PATH=${toPortablePath(ctx.keypairPath)} ` +
    `--env OMNIOLOGY_AGENT_ID=${ctx.agentId} ` +
    `-- ${launch.command} ${launch.args.join(" ")}`.trimEnd()
  );
}

function indent(s: string): string {
  return s.split("\n").map((l) => "    " + l).join("\n");
}
