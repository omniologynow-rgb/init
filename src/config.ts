/**
 * config.ts — safe read / merge / atomic-write of an MCP host config file.
 *
 * The merge logic is pure (mcpConfigMerge) so it's unit-tested: it must NEVER
 * drop a user's existing mcpServers entries, and it must detect an existing
 * Omniology connector (so we don't duplicate it or force a needless restart).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { MCP_SERVER_PKG, MCP_URL } from "./constants.js";

export interface OmniologyServerEnv {
  OMNIOLOGY_KEYPAIR_PATH: string;
  OMNIOLOGY_AGENT_ID: string;
}

type Json = Record<string, unknown>;

/** Does this config already contain an Omniology connector? */
export function hasOmniologyServer(config: Json): boolean {
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  for (const entry of Object.values(servers)) {
    const e = entry as Record<string, unknown>;
    const args = Array.isArray(e.args) ? (e.args as unknown[]).map(String).join(" ") : "";
    const url = typeof e.url === "string" ? e.url : "";
    const blob = `${args} ${url} ${JSON.stringify(e.env ?? {})}`.toLowerCase();
    if (blob.includes(MCP_SERVER_PKG.toLowerCase()) || blob.includes("omniology-engine.fly.dev")) {
      return true;
    }
  }
  return false;
}

export interface MergeResult {
  config: Json;
  alreadyPresent: boolean;
}

/**
 * Pure: return the config with an "omniology" mcpServers entry added, preserving
 * every existing entry. If an Omniology connector already exists, returns the
 * config unchanged with alreadyPresent=true.
 */
export function mcpConfigMerge(existing: Json, env: OmniologyServerEnv): MergeResult {
  if (hasOmniologyServer(existing)) {
    return { config: existing, alreadyPresent: true };
  }
  const servers = { ...((existing.mcpServers ?? {}) as Record<string, unknown>) };
  servers["omniology"] = {
    command: "npx",
    args: ["-y", MCP_SERVER_PKG],
    env: {
      OMNIOLOGY_KEYPAIR_PATH: env.OMNIOLOGY_KEYPAIR_PATH,
      OMNIOLOGY_AGENT_ID: env.OMNIOLOGY_AGENT_ID,
    },
  };
  return { config: { ...existing, mcpServers: servers }, alreadyPresent: false };
}

/** Parse a config file, tolerating a missing file (→ {}) but not malformed JSON. */
export function readConfig(path: string): Json {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  if (raw.trim() === "") return {};
  const parsed = JSON.parse(raw) as unknown; // throws on malformed → caller handles
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("config root is not a JSON object");
  }
  return parsed as Json;
}

/** Write JSON atomically: temp file in the same dir, then rename over the target. */
export function writeConfigAtomic(path: string, config: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.omniology-init-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8" });
  renameSync(tmp, path);
}

/** The connector JSON we print in manual mode. */
export function manualConfigSnippet(env: OmniologyServerEnv): string {
  return JSON.stringify(
    {
      mcpServers: {
        omniology: {
          command: "npx",
          args: ["-y", MCP_SERVER_PKG],
          env: {
            OMNIOLOGY_KEYPAIR_PATH: env.OMNIOLOGY_KEYPAIR_PATH,
            OMNIOLOGY_AGENT_ID: env.OMNIOLOGY_AGENT_ID,
          },
        },
      },
    },
    null,
    2,
  );
}

export { MCP_URL };
