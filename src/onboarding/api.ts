/**
 * api.ts — typed client for the unified 6-gate onboarding API
 * (POST/GET /api/onboard/*). Bearer auth via the 24h onboarding token minted at
 * gate 2. Every method throws OnboardApiError { code, status } on a non-2xx so
 * the flow can branch on codes (EMAIL_ALREADY_REGISTERED, USERNAME_TAKEN, …).
 *
 * The flow depends on the OnboardApi INTERFACE (not this concrete impl) so the
 * gate-sequence state machine is unit-testable with a mocked API — no network.
 */
import { ONBOARD_API_BASE } from "../constants.js";
import type { OnboardStatus } from "./gates.js";

export class OnboardApiError extends Error {
  code: string;
  status: number;
  extra: Record<string, unknown>;
  constructor(message: string, code: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "OnboardApiError";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export interface Gate5Step {
  unsigned_transaction: string;
  vault_authority: string;
  agent_usdc_ata: string;
  cap_usdc: number;
  engine_pays_network_fee: boolean;
}

export interface UsernameAvailability {
  available: boolean;
  reason?: string;
  message?: string;
}

export interface SpendingLimits {
  daily_cap_usdc: number;
  per_entry_cap_usdc: number;
  enabled_tracks: string[];
}

/** The gate-6 payload: either explicit limits, or the opt-out. */
export type Gate6Payload = SpendingLimits | { no_limits: true };

/** The surface of the onboarding API the flow drives. */
export interface OnboardApi {
  start(): Promise<{ session_id: string; resume_url?: string }>;
  gate1(input: { tosVersion: string; sessionId?: string; token?: string }): Promise<void>;
  gate2(input: { email: string; password: string; sessionId?: string }): Promise<{ onboarding_token: string }>;
  resume(input: { email: string; password: string }): Promise<{ onboarding_token: string; status: OnboardStatus }>;
  status(token: string): Promise<OnboardStatus>;
  gate3Send(token: string): Promise<{ already_verified: boolean; cooldown_seconds: number }>;
  gate3Status(token: string): Promise<{ verified: boolean }>;
  gate3Confirm(token: string, code: string): Promise<void>;
  usernameAvailable(u: string): Promise<UsernameAvailability>;
  gate4(token: string, username: string): Promise<{ username: string }>;
  gate5Local(token: string, input: { pubkey: string; capUsdc?: number }): Promise<Gate5Step>;
  gate5Confirm(token: string, txSignature: string): Promise<{ agent_id: string; remaining_usdc: number | null }>;
  gate6(token: string, payload: Gate6Payload): Promise<{ completed_at: string }>;
}

// ── HTTP implementation ───────────────────────────────────────────────────────

type Json = Record<string, unknown>;

async function request(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: Json; base?: string } = {},
): Promise<Json> {
  const base = opts.base ?? ONBOARD_API_BASE;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new OnboardApiError(
      `Couldn't reach Omniology (${base}${path}): ${e instanceof Error ? e.message : String(e)}. Check your connection and try again.`,
      "NETWORK_ERROR",
      0,
    );
  }

  const text = await res.text();
  let data: Json = {};
  try {
    data = text ? (JSON.parse(text) as Json) : {};
  } catch {
    /* non-JSON body (e.g. the magic-link HTML page) → leave {} */
  }

  if (!res.ok || data["error"] === true) {
    const code = typeof data["code"] === "string" ? (data["code"] as string) : `HTTP_${res.status}`;
    const message =
      typeof data["message"] === "string" && data["message"]
        ? (data["message"] as string)
        : `Request failed (${res.status}).`;
    throw new OnboardApiError(message, code, res.status, data);
  }
  return data;
}

/** The real HTTP-backed client. `base` is injectable for tests/staging. */
export function httpOnboardApi(base: string = ONBOARD_API_BASE): OnboardApi {
  return {
    async start() {
      const d = await request("POST", "/start", { base, body: { src: "cli" } });
      return { session_id: d["session_id"] as string, resume_url: d["resume_url"] as string | undefined };
    },
    async gate1({ tosVersion, sessionId, token }) {
      const body: Json = { tos_version: tosVersion, surface: "cli" };
      if (sessionId) body["session_id"] = sessionId;
      await request("POST", "/gate/1", { base, token, body });
    },
    async gate2({ email, password, sessionId }) {
      const body: Json = { email, password };
      if (sessionId) body["session_id"] = sessionId;
      const d = await request("POST", "/gate/2", { base, body });
      return { onboarding_token: d["onboarding_token"] as string };
    },
    async resume({ email, password }) {
      const d = await request("POST", "/resume", { base, body: { email, password } });
      const { onboarding_token, ...status } = d;
      return { onboarding_token: onboarding_token as string, status: status as unknown as OnboardStatus };
    },
    async status(token) {
      return (await request("GET", "/status", { base, token })) as unknown as OnboardStatus;
    },
    async gate3Send(token) {
      const d = await request("POST", "/gate/3/send", { base, token });
      return {
        already_verified: d["already_verified"] === true,
        cooldown_seconds: typeof d["cooldown_seconds"] === "number" ? (d["cooldown_seconds"] as number) : 0,
      };
    },
    async gate3Status(token) {
      const d = await request("GET", "/gate/3/status", { base, token });
      return { verified: d["verified"] === true };
    },
    async gate3Confirm(token, code) {
      await request("POST", "/gate/3/confirm", { base, token, body: { code } });
    },
    async usernameAvailable(u) {
      const d = await request("GET", `/username-available?u=${encodeURIComponent(u)}`, { base });
      return {
        available: d["available"] === true,
        reason: d["reason"] as string | undefined,
        message: d["message"] as string | undefined,
      };
    },
    async gate4(token, username) {
      const d = await request("POST", "/gate/4", { base, token, body: { username } });
      return { username: d["username"] as string };
    },
    async gate5Local(token, { pubkey, capUsdc }) {
      const body: Json = { pubkey };
      if (capUsdc !== undefined) body["cap_usdc"] = capUsdc;
      return (await request("POST", "/gate/5/local-keypair", { base, token, body })) as unknown as Gate5Step;
    },
    async gate5Confirm(token, txSignature) {
      const d = await request("POST", "/gate/5/confirm", { base, token, body: { tx_signature: txSignature } });
      return {
        agent_id: d["agent_id"] as string,
        remaining_usdc: (d["remaining_usdc"] as number | null) ?? null,
      };
    },
    async gate6(token, payload) {
      const d = await request("POST", "/gate/6", { base, token, body: payload as Json });
      return { completed_at: d["completed_at"] as string };
    },
  };
}
