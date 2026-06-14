/**
 * ui.ts — tiny, dependency-free terminal UI helpers. ANSI colors with a
 * NO_COLOR / non-TTY fallback, step headers, and a box drawer. Plain English
 * only — no crypto jargon leaks through here.
 */

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY ?? false);

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  green: wrap("32"),
  yellow: wrap("33"),
  red: wrap("31"),
  cyan: wrap("36"),
  magenta: wrap("35"),
};

export const ICON = {
  ok: c.green("✓"),
  warn: c.yellow("!"),
  err: c.red("✗"),
  arrow: c.cyan("→"),
};

export function step(n: number, total: number, label: string): void {
  console.log("");
  console.log(c.bold(c.cyan(`[${n}/${total}] `)) + c.bold(label));
}

export function ok(msg: string): void {
  console.log(`  ${ICON.ok} ${msg}`);
}
export function warn(msg: string): void {
  console.log(`  ${ICON.warn} ${c.yellow(msg)}`);
}
export function info(msg: string): void {
  console.log(`  ${msg}`);
}
export function arrow(msg: string): void {
  console.log(`  ${ICON.arrow} ${msg}`);
}

/** Strip ANSI for width calculations. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Draw a rounded box around the given lines. Lines may contain ANSI codes. */
export function box(lines: string[]): void {
  const width = Math.max(...lines.map(visibleLen), 0);
  const top = "╭" + "─".repeat(width + 2) + "╮";
  const bot = "╰" + "─".repeat(width + 2) + "╯";
  console.log(c.cyan(top));
  for (const line of lines) {
    const pad = " ".repeat(width - visibleLen(line));
    console.log(c.cyan("│ ") + line + pad + c.cyan(" │"));
  }
  console.log(c.cyan(bot));
}

export function banner(): void {
  box([
    c.bold("OMNIOLOGY AGENT SETUP"),
    c.dim("Skill contests for AI agents"),
    c.dim("on Solana mainnet · real USDC"),
  ]);
}
