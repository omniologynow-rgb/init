/**
 * prompts.ts — terminal input helpers for the gated onboarding flow.
 *
 * Hidden password entry (never echoed, never in argv), yes/no confirms, a
 * countdown spinner for the email-verification poll, and a stdin reader for
 * --password-stdin. All degrade gracefully in non-TTY mode.
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { c } from "../ui.js";

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Plain prompt (visible echo). Returns `def` when non-interactive or empty. */
export async function ask(question: string, def = ""): Promise<string> {
  if (!isInteractive()) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`  ${question}`)).trim();
    return ans === "" ? def : ans;
  } finally {
    rl.close();
  }
}

/** [y/N]-style confirm. Non-interactive → returns `def`. */
export async function confirm(question: string, def = false): Promise<boolean> {
  if (!isInteractive()) return def;
  const suffix = def ? "[Y/n]" : "[y/N]";
  const ans = (await ask(`${question} ${suffix}: `)).toLowerCase();
  if (ans === "") return def;
  return ans.startsWith("y");
}

/**
 * Hidden password entry — the typed characters are not echoed. Uses a muted
 * output stream so nothing (not even asterisks) leaks to the terminal or scroll
 * buffer. Non-interactive callers must use --password-stdin instead.
 */
export async function askHidden(question: string): Promise<string> {
  let muted = false;
  const muffled = new Writable({
    write(chunk, encoding, cb) {
      if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muffled, terminal: true });
  return new Promise<string>((resolve) => {
    // question() writes the prompt synchronously; mute immediately after so the
    // prompt shows but the keystrokes do not.
    void rl.question(`  ${question}`).then((answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

/** Read all of stdin to EOF (for --password-stdin). Trims a single trailing newline. */
export function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (d: Buffer) => chunks.push(d));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Format seconds as M:SS for the countdown. */
export function formatCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export interface PollSpinnerDeps {
  /** returns true once the awaited condition is met. */
  check: () => Promise<boolean>;
  pollMs: number;
  timeoutMs: number;
  label: string;
  /** injectable for tests */
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  write?: (s: string) => void;
}

/**
 * Poll `check` every pollMs until it returns true or timeoutMs elapses, showing
 * a friendly single-line countdown (TTY) or periodic lines (non-TTY). Returns
 * true if the condition was met. Pure-ish: clock + sleep + writer injectable.
 */
export async function pollWithCountdown(deps: PollSpinnerDeps): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const doSleep = deps.sleepFn ?? sleep;
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const tty = Boolean(process.stdout.isTTY) && deps.write === undefined;
  const start = now();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await deps.check()) {
      if (tty) write("\r" + " ".repeat(72) + "\r");
      return true;
    }
    const elapsed = now() - start;
    if (elapsed >= deps.timeoutMs) {
      if (tty) write("\n");
      return false;
    }
    const left = formatCountdown((deps.timeoutMs - elapsed) / 1000);
    const frame = frames[i++ % frames.length] ?? "⠋";
    if (tty) {
      write(`\r  ${c.cyan(frame)} ${deps.label} ${c.dim(`(${left} left)`)}   `);
    } else {
      write(`  … ${deps.label} (${left} left)\n`);
    }
    await doSleep(deps.pollMs);
  }
}
