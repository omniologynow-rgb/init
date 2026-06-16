/**
 * Cline surface — write the omniology entry to Cline's MCP settings JSON (found
 * in VS Code globalStorage, e.g. .../saoudrizwan.claude-dev/settings/cline_mcp_settings.json).
 * Atomic write, preserving existing entries.
 */
import { currentPlatform, findClineConfigPath } from "../hosts.js";
import { readConfig, mcpConfigMerge, mcpConfigUpsert, writeConfigAtomic, manualConfigSnippet, toPortablePath } from "../config.js";
import { ok, warn, info } from "../ui.js";
import type { InstallContext, InstallResult } from "./types.js";

export async function install(ctx: InstallContext, pathOverride?: string): Promise<InstallResult> {
  const env = {
    OMNIOLOGY_KEYPAIR_PATH: toPortablePath(ctx.keypairPath),
    OMNIOLOGY_AGENT_ID: ctx.agentId,
  };
  const path = pathOverride ?? findClineConfigPath(currentPlatform());

  if (!path) {
    warn("Couldn't locate Cline's MCP settings file (is Cline installed in VS Code?).");
    info("Open VS Code → Cline → MCP Servers → Configure, and add this under mcpServers:");
    console.log(indent(manualConfigSnippet(env)));
    return { ok: false, verified: null, openHint: "Add the entry above via Cline's MCP settings, then restart VS Code." };
  }

  let existing: Record<string, unknown>;
  try {
    existing = readConfig(path);
  } catch {
    warn(`Cline's settings at ${path} isn't valid JSON, so I didn't touch it. Add this under mcpServers:`);
    console.log(indent(manualConfigSnippet(env)));
    return { ok: false, verified: null, openHint: "Add the entry above to Cline's settings, then restart VS Code." };
  }

  if (ctx.force) {
    writeConfigAtomic(path, mcpConfigUpsert(existing, env));
    ok(`Updated Omniology in ${path} → @latest (existing servers preserved).`);
  } else {
    const merged = mcpConfigMerge(existing, env);
    if (merged.alreadyPresent) {
      ok("Omniology connector already in Cline's settings — leaving it as-is.");
      return { ok: true, verified: true, openHint: "Restart VS Code if you haven't — Omniology is ready." };
    }
    writeConfigAtomic(path, merged.config);
    ok(`Added Omniology to ${path} (existing servers preserved).`);
  }

  const verified = (() => {
    try {
      const back = readConfig(path);
      const e = ((back.mcpServers ?? {}) as Record<string, { env?: Record<string, string> }>).omniology;
      return Boolean(e && e.env?.OMNIOLOGY_AGENT_ID === ctx.agentId);
    } catch {
      return false;
    }
  })();
  if (verified) ok("Verified: the omniology entry is in Cline's settings.");
  else warn("Wrote the config but couldn't verify on read-back — please double-check Cline's MCP settings.");

  info("Restart VS Code to load Omniology.");
  return { ok: true, verified, openHint: "Restart VS Code to load Omniology." };
}

function indent(s: string): string {
  return s.split("\n").map((l) => "    " + l).join("\n");
}
