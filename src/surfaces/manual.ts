/** Manual surface — print the connector JSON + per-host pointers. */
import { manualConfigSnippet, toPortablePath, npxLaunch } from "../config.js";
import { claudeAddCommand } from "./claude-code.js";
import { openclawAddCommand } from "./openclaw.js";
import { info, arrow } from "../ui.js";
import { DOCS_URL } from "../constants.js";
import type { InstallContext, InstallResult } from "./types.js";

export async function install(ctx: InstallContext): Promise<InstallResult> {
  const launch = ctx.launch ?? npxLaunch();
  const env = {
    OMNIOLOGY_KEYPAIR_PATH: toPortablePath(ctx.keypairPath),
    OMNIOLOGY_AGENT_ID: ctx.agentId,
  };
  info("Add Omniology to your AI host yourself. This entry preserves anything you already have:");
  console.log("");
  console.log(manualConfigSnippet(env, launch).split("\n").map((l) => "    " + l).join("\n"));
  console.log("");
  arrow("Claude Code: " + claudeAddCommand(ctx));
  arrow("Cursor: add the block above to ~/.cursor/mcp.json (then restart Cursor).");
  arrow("Cline: add the block above via Cline → MCP Servers (then restart VS Code).");
  arrow("OpenClaw: " + openclawAddCommand(ctx));
  arrow("Any other host: see ~/.omniology/SETUP.md — launch command, env, and the 3-call compete loop.");
  info(`More help: ${DOCS_URL}`);
  return { ok: true, verified: null, openHint: "Add the config to your host (see ~/.omniology/SETUP.md), then restart it." };
}
