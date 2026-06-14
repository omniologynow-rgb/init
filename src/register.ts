/** register.ts — sign the ownership proof and register the agent with the engine. */
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { MCP_URL, TERMS_URL } from "./constants.js";

const REGISTER_DOMAIN = "omniology-register-v1";

/** Build the raw-ed25519 registration proof (same format the engine expects). */
export function buildRegisterProof(kp: Keypair, nowSeconds: number): {
  wallet_address: string;
  signed_message: string;
  message_body: string;
} {
  const wallet = kp.publicKey.toBase58();
  const message_body = `${REGISTER_DOMAIN}:${wallet}:${nowSeconds}`;
  const sig = ed25519.sign(new TextEncoder().encode(message_body), kp.secretKey.slice(0, 32));
  return { wallet_address: wallet, signed_message: bs58.encode(sig), message_body };
}

/** Minimal MCP Streamable-HTTP tools/call. Returns the parsed tool result JSON. */
export async function mcpCall(
  name: string,
  args: Record<string, unknown>,
  url = MCP_URL,
): Promise<{ data: Record<string, unknown> | null; isError: boolean; rawText: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const m = text.match(/data: (\{.*\})\s*$/s) || text.match(/(\{"result"[\s\S]*\})\s*$/);
  let envelope: { result?: { content?: Array<{ text?: string }>; isError?: boolean } } = {};
  try {
    envelope = JSON.parse(m ? m[1]! : text);
  } catch {
    /* leave empty */
  }
  const content = envelope.result?.content?.[0]?.text ?? "";
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { data, isError: envelope.result?.isError === true, rawText: content || text };
}

export interface RegisterResult {
  agent_id: string;
  email_verification_sent?: boolean;
}

/**
 * Register the agent. Signs in-process and calls register_agent on the engine.
 * Returns the agent_id. Throws a plain-English error on failure.
 */
export async function registerAgent(
  kp: Keypair,
  opts: { email?: string; displayName?: string; rpcUrlUnused?: string },
): Promise<RegisterResult> {
  const proof = buildRegisterProof(kp, Math.floor(Date.now() / 1000));
  const args: Record<string, unknown> = {
    wallet_address: proof.wallet_address,
    signed_message: proof.signed_message,
    message_body: proof.message_body,
    terms_of_service_accepted: true,
  };
  if (opts.email) args.email = opts.email;
  if (opts.displayName) args.display_name = opts.displayName;

  const { data, isError, rawText } = await mcpCall("register_agent", args);

  if (isError || !data || data.error) {
    const msg = (data?.message as string) || rawText || "unknown error";
    // Friendly translation of the common cases.
    if (/already|duplicate|in use|exists/i.test(msg)) {
      throw new Error("This wallet or email is already registered with Omniology. If you meant to reuse your existing agent, you're all set — just configure your host. To start completely fresh, re-run with --reset and a different email.");
    }
    if (/email/i.test(msg) && /required|invalid/i.test(msg)) {
      throw new Error(`Registration needs a valid email. Re-run and provide one (or omit --no-email). By continuing you accept the Terms of Service at ${TERMS_URL}.`);
    }
    throw new Error(`Registration didn't go through: ${msg}`);
  }

  const agentId = data.agent_id as string | undefined;
  if (!agentId) throw new Error(`Registration returned no agent_id. Response: ${rawText.slice(0, 200)}`);
  return { agent_id: agentId, email_verification_sent: data.email_verification_sent as boolean | undefined };
}
