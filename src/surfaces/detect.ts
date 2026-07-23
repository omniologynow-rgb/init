/**
 * detect.ts — figure out which Claude/agent surfaces are usable on this machine.
 * Filesystem/env probing is delegated to the per-OS path helpers in hosts.ts;
 * Claude Code is probed by running `claude --version` (injectable for tests).
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Exec, SurfaceId } from "./types.js";
import { defaultExec } from "./exec.js";
import {
  currentPlatform,
  cursorConfigPath,
  findClineConfigPath,
  isCowork,
  openclawInstalled,
  type PlatformEnv,
} from "../hosts.js";

export interface SurfaceAvailability {
  id: SurfaceId;
  label: string;
  installed: boolean;
  recommended?: boolean;
  detail?: string;
}

/** Is Claude Code's CLI on PATH? */
export function claudeCodeInstalled(exec: Exec = defaultExec): boolean {
  const r = exec("claude", ["--version"]);
  return !r.spawnError && r.status === 0;
}

/**
 * Detect every surface, in the order we want to present them (Claude Code first
 * and recommended). `manual` is always available.
 */
export function detectSurfaces(
  p: PlatformEnv = currentPlatform(),
  exec: Exec = defaultExec,
): SurfaceAvailability[] {
  const cursorPath = cursorConfigPath(p);
  const clinePath = findClineConfigPath(p);
  return [
    {
      id: "claude-code",
      label: "Claude Code (recommended)",
      installed: claudeCodeInstalled(exec),
      recommended: true,
      detail: "Runs the autonomous agent locally with full signing support.",
    },
    {
      id: "cursor",
      label: "Cursor",
      // Cursor stores config under ~/.cursor; treat the dir existing as installed.
      installed: existsSync(dirname(cursorPath)),
    },
    {
      id: "cline",
      label: "Cline (VS Code)",
      installed: Boolean(clinePath),
    },
    {
      id: "openclaw",
      label: "OpenClaw",
      installed: openclawInstalled(p),
      detail: "Registers via `openclaw mcp add` — the agent holds its key and self-signs.",
    },
    {
      id: "cowork",
      label: "Cowork",
      installed: isCowork(p),
      detail: "Limited: sandboxed plugins can't reach your local wallet yet.",
    },
    { id: "manual", label: "Manual (show me the config)", installed: true },
  ];
}
