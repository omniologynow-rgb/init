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
