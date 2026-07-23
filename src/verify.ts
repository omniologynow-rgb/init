/**
 * verify.ts — `omniology-init --verify`: one command that says "you're ready" or
 * the exact blocker. Dependency-free: it reuses the engine's get_agent_status
 * (the same readiness source the MCP surface exposes) via the raw MCP call in
 * register.ts, so it needs no new deps and never spawns a local server.
 */
import { existsSync, readFileSync } from "node:fs";
import { keypairPath, agentPath, type AgentRecord } from "./paths.js";
import { loadKeypair } from "./wallet.js";
import { mcpCall } from "./register.js";
import { c, box, ok, warn, info } from "./ui.js";

export interface VerifyResult {
  ready: boolean;
  lines: string[];
}

interface AgentStatus {
  registered?: boolean;
  email_verified?: boolean;
  wallet_address?: string;
  available_usdc?: number;
  signing_mode?: string;
  can_enter_contests?: boolean;
  blocking_reasons?: string[];
  remediation?: Array<{ reason: string; action: string; deposit_address?: string; min_usdc?: number }>;
}

/**
 * Pure readiness decision (no IO) — given the local wallet, the registered
 * agent, and the engine status, produce ready/blocker lines. Unit-testable
 * without touching ~/.omniology or the network.
 */
export function decideReadiness(
  wallet: string,
  agent: { agent_id: string; wallet_address?: string },
  status: AgentStatus | null,
): VerifyResult {
  const lines: string[] = [];

  // Local-key binding: the registered wallet MUST be this keypair's pubkey, or
  // the agent can't sign for its own wallet (the Ryker failure).
  if (agent.wallet_address && agent.wallet_address !== wallet) {
    lines.push(c.red("✗") + ` Local key ${wallet.slice(0, 8)}… does NOT match the registered wallet ${agent.wallet_address.slice(0, 8)}… — this agent can't self-sign.`);
    return { ready: false, lines };
  }
  lines.push(`${c.green("✓")} Local key holds the registered wallet ${wallet.slice(0, 8)}… (self-signing).`);

  if (!status) {
    lines.push(c.yellow("!") + " Couldn't reach the engine to check live readiness. Check your network and retry.");
    return { ready: false, lines };
  }

  lines.push(`${c.green("✓")} Registered (agent ${agent.agent_id.slice(0, 8)}…), signing mode: ${status.signing_mode ?? "local_key"}.`);

  if (status.can_enter_contests) {
    lines.push(`${c.green("✓")} Email verified, funded (${(status.available_usdc ?? 0).toFixed(2)} USDC available).`);
    lines.push("");
    lines.push(c.bold(c.green("READY — your agent can compete right now.")));
    return { ready: true, lines };
  }

  // Not ready → surface the EXACT blocker(s) + remediation.
  lines.push("");
  lines.push(c.bold("Not ready yet:"));
  const rem = status.remediation ?? [];
  for (const reason of status.blocking_reasons ?? []) {
    const r = rem.find((x) => x.reason === reason);
    if (reason === "EMAIL_NOT_VERIFIED") {
      lines.push(`  • Email not verified — ${r?.action ?? "run request_email_verification and click the link."}`);
    } else if (reason === "INSUFFICIENT_USDC") {
      const addr = r?.deposit_address ?? wallet;
      const min = r?.min_usdc ?? 0.01;
      lines.push(`  • Needs USDC — deposit at least ${min} USDC (Solana) to ${addr} (no SOL needed; the engine pays gas).`);
    } else {
      lines.push(`  • ${reason}${r?.action ? ` — ${r.action}` : ""}`);
    }
  }
  return { ready: false, lines };
}

/**
 * Gather readiness: read the local keypair + agent.json, fetch live status via
 * the injectable fetcher, then decide. Returns ready + human-readable lines.
 */
export async function computeVerify(
  fetchStatus: (agentId: string) => Promise<AgentStatus | null>,
): Promise<VerifyResult> {
  if (!existsSync(keypairPath())) {
    return { ready: false, lines: [`No agent wallet at ${keypairPath()}. Run \`npx omniology-init\` first.`] };
  }
  const wallet = loadKeypair(keypairPath()).publicKey.toBase58();

  let agent: AgentRecord | null = null;
  if (existsSync(agentPath())) {
    try { agent = JSON.parse(readFileSync(agentPath(), "utf8")) as AgentRecord; } catch { agent = null; }
  }
  if (!agent?.agent_id) {
    return { ready: false, lines: [
      `Local key found (${wallet.slice(0, 8)}…) but no registered agent. Run \`npx omniology-init\` to finish onboarding.`,
    ] };
  }

  const status = await fetchStatus(agent.agent_id);
  return decideReadiness(wallet, agent, status);
}

/** The real fetcher: engine get_agent_status via the raw MCP call. */
async function fetchAgentStatus(agentId: string): Promise<AgentStatus | null> {
  try {
    const { data } = await mcpCall("get_agent_status", { agent_id: agentId });
    return (data as AgentStatus) ?? null;
  } catch {
    return null;
  }
}

/** CLI entry: run the check and print a box. Exits non-zero handled by caller. */
export async function runVerify(): Promise<boolean> {
  info("Checking whether your agent is ready to compete…");
  const result = await computeVerify(fetchAgentStatus);
  box([c.bold("Omniology readiness"), "", ...result.lines]);
  if (result.ready) ok("You're set.");
  else warn("Not ready — see the blocker above. Re-run --verify after fixing it.");
  return result.ready;
}
