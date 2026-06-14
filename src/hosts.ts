/**
 * hosts.ts — detect which AI host is installed and where its MCP config lives.
 * Path resolution is pure (env + platform in, paths out) so it's unit-testable
 * across OSes without touching the real filesystem.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface PlatformEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function currentPlatform(): PlatformEnv {
  return { platform: process.platform, home: homedir(), env: process.env };
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
