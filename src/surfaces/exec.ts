/** Default command executor (spawnSync), kept separate so tests inject a fake. */
import { spawnSync } from "node:child_process";
import type { Exec, ExecResult } from "./types.js";

export const defaultExec: Exec = (cmd: string, args: string[]): ExecResult => {
  // shell:true on Windows so `claude` (a .cmd shim) resolves on PATH.
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    timeout: 60_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    spawnError: Boolean(r.error),
  };
};
