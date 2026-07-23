/** Shared types for surface install routing (v0.2.0). */
import type { Options, SurfaceId } from "../flags.js";

export type { SurfaceId };

/** How to launch the stdio MCP server (command + args written into host config).
 *  Resolved once per run (npx vs the Windows-robust global `omniology-mcp` bin)
 *  and threaded to every surface. */
export interface LaunchSpec {
  command: string;
  args: string[];
}

/** Everything a surface needs to wire up the autonomous MCP. */
export interface InstallContext {
  keypairPath: string;
  agentId: string;
  opts: Options;
  /** How to launch the server (npx or the global binary). Defaults to npx when
   *  a caller doesn't resolve one. */
  launch?: LaunchSpec;
  /** Reconfigure: overwrite an existing omniology entry (to @latest) instead of
   *  skipping when it's already present. */
  force?: boolean;
}

export interface InstallResult {
  /** Did the install step itself succeed (config written / command run)? */
  ok: boolean;
  /** Post-install verification outcome: true = confirmed, false = failed, null = N/A. */
  verified: boolean | null;
  /** A short instruction line for the success box (e.g. how to open the host). */
  openHint: string;
  /** Extra lines already printed by the surface (for logging/debug). */
  notes?: string[];
}

/** Minimal command executor, injectable for tests. */
export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary couldn't be spawned at all (ENOENT etc.). */
  spawnError: boolean;
}
export type Exec = (cmd: string, args: string[]) => ExecResult;
