/** Filesystem locations for Omniology agent state (~/.omniology). */
import { homedir } from "node:os";
import { join } from "node:path";

export function omniologyDir(): string {
  return join(homedir(), ".omniology");
}
export function keypairPath(): string {
  return join(omniologyDir(), "keypair.json");
}
export function agentPath(): string {
  return join(omniologyDir(), "agent.json");
}

/** Shape of ~/.omniology/agent.json. */
export interface AgentRecord {
  agent_id: string;
  wallet_address: string;
  email?: string;
  display_name?: string;
  registered_at: string;
  network: "mainnet";
}
