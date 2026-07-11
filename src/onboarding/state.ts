/**
 * state.ts — persist just enough onboarding state to resume across runs.
 *
 * Stored at ~/.omniology/onboarding.json. Holds the operator email, the 24h
 * onboarding token (a short-lived bearer, NOT a password — the password is never
 * written to disk), and the last known gate. On a re-run we reuse a still-valid
 * token to fetch /status and jump to the first incomplete gate; an expired token
 * falls back to a login (POST /resume).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { omniologyDir } from "../paths.js";
import { writeConfigAtomic } from "../config.js";

export function onboardingStatePath(): string {
  return join(omniologyDir(), "onboarding.json");
}

export interface OnboardingState {
  email: string;
  onboarding_token: string;
  /** ISO timestamp; the token is a 24h JWT. We treat it as expired a little
   *  early to avoid a mid-flow 401. */
  token_saved_at: string;
  agent_id?: string;
  wallet_address?: string;
  updated_at: string;
}

const TOKEN_TTL_MS = 24 * 3600 * 1000;
/** Refresh a bit before the real 24h expiry to avoid an edge 401. */
const TOKEN_SAFETY_MS = 30 * 60 * 1000;

export function readOnboardingState(): OnboardingState | null {
  try {
    const raw = readFileSync(onboardingStatePath(), "utf8");
    const parsed = JSON.parse(raw) as OnboardingState;
    if (parsed && typeof parsed.email === "string" && typeof parsed.onboarding_token === "string") {
      return parsed;
    }
  } catch {
    /* missing/unreadable → no saved state */
  }
  return null;
}

/** Is the saved token still safely valid? Pure (clock injectable). */
export function tokenStillValid(state: OnboardingState, now: number = Date.now()): boolean {
  const saved = Date.parse(state.token_saved_at);
  if (!Number.isFinite(saved)) return false;
  return now - saved < TOKEN_TTL_MS - TOKEN_SAFETY_MS;
}

export function saveOnboardingState(patch: Partial<OnboardingState> & { email: string; onboarding_token: string }): void {
  const prev = readOnboardingState() ?? ({} as Partial<OnboardingState>);
  const now = new Date().toISOString();
  const next: OnboardingState = {
    email: patch.email,
    onboarding_token: patch.onboarding_token,
    token_saved_at: patch.token_saved_at ?? now,
    agent_id: patch.agent_id ?? prev.agent_id,
    wallet_address: patch.wallet_address ?? prev.wallet_address,
    updated_at: now,
  };
  writeConfigAtomic(onboardingStatePath(), next as unknown as Record<string, unknown>);
}
