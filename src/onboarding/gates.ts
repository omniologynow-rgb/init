/**
 * gates.ts — pure gate math for the 6-gate onboarding state machine (v1.4.0).
 *
 * Mirrors the engine's computeCurrentGate: the CLI resumes at the first
 * incomplete gate. Kept pure so the sequencing is unit-testable offline.
 */

export const GATE_COUNT = 6;

/** Gate timestamps as returned by GET /api/onboard/status (nulls = incomplete). */
export interface GateTimestamps {
  gate_1_at: string | null;
  gate_2_at: string | null;
  gate_3_at: string | null;
  gate_4_at: string | null;
  gate_5_at: string | null;
  gate_6_at: string | null;
  completed_at: string | null;
}

export interface OnboardStatus {
  email: string;
  gates: GateTimestamps;
  current_gate: number | null;
  wallet_type: string | null;
  pubkey: string | null;
  enrolled: boolean;
  just_completed: boolean;
}

/** First incomplete gate (1–6), or null when onboarding is complete. Pure. */
export function firstIncompleteGate(g: GateTimestamps): number | null {
  if (g.completed_at) return null;
  if (!g.gate_1_at) return 1;
  if (!g.gate_2_at) return 2;
  if (!g.gate_3_at) return 3;
  if (!g.gate_4_at) return 4;
  if (!g.gate_5_at) return 5;
  return 6;
}

/** Human label for a gate number (progress headers + logs). */
export function gateLabel(gate: number): string {
  switch (gate) {
    case 1: return "Review the Terms";
    case 2: return "Create your account";
    case 3: return "Verify your email";
    case 4: return "Choose a username";
    case 5: return "Connect your Balance";
    case 6: return "Spending limits";
    default: return `Gate ${gate}`;
  }
}

/** Is onboarding already finished for this status? Pure. */
export function isComplete(g: GateTimestamps): boolean {
  return firstIncompleteGate(g) === null;
}
