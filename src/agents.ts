/**
 * agents.ts — discover every Omniology agent that exists on this device.
 *
 * Motivation: an operator ended up with 3 "ghost" agents because init silently
 * reused/overwrote a single slot. Each destructive write COPIES ~/.omniology to
 * ~/.omniology.bak/<ts>/ (see safety.ts), so past agents are still on disk. This
 * module surfaces ALL of them — the active slot + every archived copy — so the
 * picker can make each one an explicit, visible choice (run-as vs create-new)
 * instead of guessing. Pure + injectable so it's unit-testable without real fs.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { omniologyDir, keypairPath, agentPath, type AgentRecord } from "./paths.js";
import { currentPlatform, cursorConfigPath, findClineConfigPath, openclawConfigDir } from "./hosts.js";

export interface DiscoveredAgent {
  agentId: string;
  /** Agent name (display_name), or "(unnamed)" if none was set. */
  name: string;
  /** On-chain address from agent.json (may be "" for very old records). */
  walletAddress: string;
  /** The keypair file to use / restore for this agent. */
  keypairPath: string;
  /** The agent.json file for this agent. */
  agentJsonPath: string;
  /** Where it lives: the live slot, or an archived backup copy. */
  source: "active" | "archived";
  /** Backup stamp (archived only). */
  archivedAt?: string;
}

export interface DiscoverDeps {
  activeDir: string;
  bakRoot: string;
  exists: (p: string) => boolean;
  /** Parse a JSON file, or null on missing/garbage. */
  readJson: (p: string) => Record<string, unknown> | null;
  /** List a directory's entries, or [] if unreadable. */
  listDir: (p: string) => string[];
}

export function defaultDiscoverDeps(): DiscoverDeps {
  return {
    activeDir: omniologyDir(),
    bakRoot: join(homedir(), ".omniology.bak"),
    exists: existsSync,
    readJson: (p) => {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Discover all agents on the device, deduped by agent_id. The active slot wins
 * over archived copies; among archives, the newest stamp wins. Only entries with
 * BOTH a keypair.json and a valid agent.json (with an agent_id) are returned.
 */
export function discoverAgents(deps: DiscoverDeps = defaultDiscoverDeps()): DiscoveredAgent[] {
  const out: DiscoveredAgent[] = [];
  const seen = new Set<string>();

  const consider = (dir: string, source: "active" | "archived", stamp?: string): void => {
    const kp = join(dir, "keypair.json");
    const aj = join(dir, "agent.json");
    if (!deps.exists(kp) || !deps.exists(aj)) return;
    const rec = deps.readJson(aj) as Partial<AgentRecord> | null;
    if (!rec || typeof rec.agent_id !== "string" || rec.agent_id === "") return;
    if (seen.has(rec.agent_id)) return;
    seen.add(rec.agent_id);
    out.push({
      agentId: rec.agent_id,
      name: (typeof rec.display_name === "string" && rec.display_name) || "(unnamed)",
      walletAddress: typeof rec.wallet_address === "string" ? rec.wallet_address : "",
      keypairPath: kp,
      agentJsonPath: aj,
      source,
      archivedAt: stamp,
    });
  };

  // Active slot first (preferred on dedup).
  consider(deps.activeDir, "active");

  // Archived copies, newest stamp first (ISO stamps sort lexicographically).
  if (deps.exists(deps.bakRoot)) {
    const stamps = deps.listDir(deps.bakRoot).sort().reverse();
    for (const s of stamps) consider(join(deps.bakRoot, s), "archived", s);
  }

  return out;
}

/** True when the given agent already occupies the live ~/.omniology slot. */
export function isActiveAgent(a: DiscoveredAgent): boolean {
  return a.source === "active" && a.keypairPath === keypairPath() && a.agentJsonPath === agentPath();
}

// ── Identity reconcile: what Connect ID is each host actually configured for? ──
//
// A live agent's host was wired to one Connect ID while its local credentials
// pointed at another. The tools then behaved as a different agent, and the
// operator fell back to hand-rolled raw HTTP to get anything done. We surface
// the mismatch up front so the device runs on ONE identity.

export interface ConfiguredIdentity {
  /** Which host config it came from (cursor / cline / openclaw). */
  surface: string;
  /** The OMNIOLOGY_AGENT_ID that host will run as. */
  agentId: string;
  /** The config file it was read from. */
  path: string;
}

export interface ConfiguredDeps {
  /** Config files to inspect. `nested` = OpenClaw's `mcp.servers` shape. */
  sources: Array<{ surface: string; path: string | undefined; nested?: boolean }>;
  exists: (p: string) => boolean;
  readJson: (p: string) => Record<string, unknown> | null;
}

/**
 * Read the Connect ID each installed host is configured to run as. Only reads
 * config files — never writes, never touches keys.
 */
export function readConfiguredAgentIds(deps: ConfiguredDeps): ConfiguredIdentity[] {
  const out: ConfiguredIdentity[] = [];
  for (const src of deps.sources) {
    if (!src.path || !deps.exists(src.path)) continue;
    const cfg = deps.readJson(src.path);
    if (!cfg) continue;
    const servers = src.nested
      ? ((cfg["mcp"] as Record<string, unknown> | undefined)?.["servers"] as Record<string, unknown> | undefined)
      : (cfg["mcpServers"] as Record<string, unknown> | undefined);
    if (!servers || typeof servers !== "object") continue;
    for (const entry of Object.values(servers)) {
      const env = (entry as { env?: Record<string, unknown> } | null)?.env;
      const id = env?.["OMNIOLOGY_AGENT_ID"];
      if (typeof id === "string" && id.trim() !== "") {
        out.push({ surface: src.surface, agentId: id.trim(), path: src.path });
        break; // one Omniology entry per host is enough
      }
    }
  }
  return out;
}

/** Real host-config locations to inspect for a configured Connect ID. */
export function defaultConfiguredDeps(): ConfiguredDeps {
  const p = currentPlatform();
  const readJson = (path: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  return {
    sources: [
      { surface: "cursor", path: cursorConfigPath(p) },
      { surface: "cline", path: findClineConfigPath(p) },
      { surface: "openclaw", path: join(openclawConfigDir(p), "openclaw.json"), nested: true },
    ],
    exists: existsSync,
    readJson,
  };
}

/**
 * Pure: which configured identities disagree with the agent this device would
 * otherwise run as? Returns the mismatching entries (empty = all consistent).
 */
export function identityMismatches(
  configured: ConfiguredIdentity[],
  activeAgentId: string | undefined,
): ConfiguredIdentity[] {
  if (!activeAgentId) return [];
  return configured.filter((c) => c.agentId !== activeAgentId);
}
