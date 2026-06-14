/**
 * hosts.ts — detect which AI host is installed and where its MCP config lives.
 * Path resolution is pure (env + platform in, paths out) so it's unit-testable
 * across OSes without touching the real filesystem.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HostName } from "./flags.js";

export interface HostInfo {
  host: HostName;
  label: string;
  /** Absolute path to the host's MCP config JSON (undefined for cowork/manual). */
  configPath?: string;
}

export interface PlatformEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function currentPlatform(): PlatformEnv {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/** Claude Desktop config path for the platform (pure). */
export function claudeDesktopConfigPath(p: PlatformEnv): string {
  if (p.platform === "darwin") {
    return join(p.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (p.platform === "win32") {
    const appData = p.env.APPDATA ?? join(p.home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(p.home, ".config", "Claude", "claude_desktop_config.json");
}

export function cursorConfigPath(p: PlatformEnv): string {
  return join(p.home, ".cursor", "mcp.json");
}

/** VS Code globalStorage base, where Cline keeps cline_mcp_settings.json. */
function vscodeGlobalStorageDirs(p: PlatformEnv): string[] {
  const bases: string[] = [];
  const add = (...parts: string[]) => bases.push(join(...parts));
  if (p.platform === "darwin") {
    add(p.home, "Library", "Application Support", "Code", "User", "globalStorage");
    add(p.home, "Library", "Application Support", "Code - Insiders", "User", "globalStorage");
  } else if (p.platform === "win32") {
    const appData = p.env.APPDATA ?? join(p.home, "AppData", "Roaming");
    add(appData, "Code", "User", "globalStorage");
    add(appData, "Code - Insiders", "User", "globalStorage");
  } else {
    add(p.home, ".config", "Code", "User", "globalStorage");
    add(p.home, ".config", "Code - Insiders", "User", "globalStorage");
  }
  return bases;
}

/** Find Cline's settings file by searching VS Code globalStorage (impure). */
export function findClineConfigPath(p: PlatformEnv): string | undefined {
  const FILE = "cline_mcp_settings.json";
  for (const base of vscodeGlobalStorageDirs(p)) {
    if (!existsSync(base)) continue;
    // Common locations: <base>/saoudrizwan.claude-dev/settings/<FILE>
    let dirs: string[];
    try {
      dirs = readdirSync(base);
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.toLowerCase().includes("claude-dev") && !d.toLowerCase().includes("cline")) continue;
      const candidate = join(base, d, "settings", FILE);
      if (existsSync(candidate)) return candidate;
      const flat = join(base, d, FILE);
      if (existsSync(flat)) return flat;
    }
  }
  return undefined;
}

/** True when running inside a Cowork sandbox. */
export function isCowork(p: PlatformEnv): boolean {
  if (p.env.COWORK_SESSION_ID) return true;
  try {
    return existsSync("/sessions") && readdirSync("/sessions").some((s) => existsSync(join("/sessions", s, "mnt")));
  } catch {
    return false;
  }
}

/**
 * Detect all plausible hosts on this machine (impure: checks the filesystem).
 * Order: Cowork → Claude Desktop → Cursor → Cline.
 */
export function detectHosts(p: PlatformEnv = currentPlatform()): HostInfo[] {
  const found: HostInfo[] = [];
  if (isCowork(p)) found.push({ host: "cowork", label: "Cowork (sandboxed session)" });

  const claude = claudeDesktopConfigPath(p);
  if (existsSync(claude)) found.push({ host: "claude-desktop", label: "Claude Desktop", configPath: claude });

  const cursor = cursorConfigPath(p);
  if (existsSync(cursor)) found.push({ host: "cursor", label: "Cursor", configPath: cursor });

  const cline = findClineConfigPath(p);
  if (cline) found.push({ host: "cline", label: "Cline (VS Code)", configPath: cline });

  return found;
}

/** Resolve a HostInfo for an explicit --host choice (no detection). */
export function hostInfoFor(host: HostName, p: PlatformEnv = currentPlatform()): HostInfo {
  switch (host) {
    case "claude-desktop": return { host, label: "Claude Desktop", configPath: claudeDesktopConfigPath(p) };
    case "cursor": return { host, label: "Cursor", configPath: cursorConfigPath(p) };
    case "cline": return { host, label: "Cline (VS Code)", configPath: findClineConfigPath(p) };
    case "cowork": return { host, label: "Cowork (sandboxed session)" };
    case "manual": return { host, label: "Manual (print config)" };
  }
}
