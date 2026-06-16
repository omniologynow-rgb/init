/** Cursor surface — write the omniology entry to ~/.cursor/mcp.json (atomic, preserving existing). */
import { currentPlatform, cursorConfigPath } from "../hosts.js";
import { readConfig, mcpConfigMerge, mcpConfigUpsert, writeConfigAtomic, manualConfigSnippet, toPortablePath } from "../config.js";
import { ok, warn, info } from "../ui.js";
import type { InstallContext, InstallResult } from "./types.js";

export async function install(ctx: InstallContext, pathOverride?: string): Promise<InstallResult> {
  const path = pathOverride ?? cursorConfigPath(currentPlatform());
  const env = {
    OMNIOLOGY_KEYPAIR_PATH: toPortablePath(ctx.keypairPath),
    OMNIOLOGY_AGENT_ID: ctx.agentId,
  };

  let existing: Record<string, unknown>;
  try {
    existing = readConfig(path);
  } catch {
    warn(`Your Cursor MCP config at ${path} isn't valid JSON, so I didn't touch it. Add this under mcpServers:`);
    console.log(indent(manualConfigSnippet(env)));
    return { ok: false, verified: null, openHint: "Add the entry above to ~/.cursor/mcp.json, then restart Cursor." };
  }

  if (ctx.force) {
    writeConfigAtomic(path, mcpConfigUpsert(existing, env));
    ok(`Updated Omniology in ${path} → @latest (existing servers preserved).`);
  } else {
    const merged = mcpConfigMerge(existing, env);
    if (merged.alreadyPresent) {
      ok("Omniology connector already in your Cursor config — leaving it as-is.");
      return { ok: true, verified: true, openHint: "Open Cursor — Omniology is ready." };
    }
    writeConfigAtomic(path, merged.config);
    ok(`Added Omniology to ${path} (existing servers preserved).`);
  }

  // Verify by reading it back.
  const verified = (() => {
    try {
      const back = readConfig(path);
      const e = ((back.mcpServers ?? {}) as Record<string, { env?: Record<string, string> }>).omniology;
      return Boolean(e && e.env?.OMNIOLOGY_AGENT_ID === ctx.agentId);
    } catch {
      return false;
    }
  })();
  if (verified) ok("Verified: the omniology entry is in your Cursor config.");
  else warn("Wrote the config but couldn't verify it on read-back — please double-check Cursor's MCP settings.");

  info("Restart Cursor to load Omniology.");
  return { ok: true, verified, openHint: "Restart Cursor to load Omniology." };
}

function indent(s: string): string {
  return s.split("\n").map((l) => "    " + l).join("\n");
}
