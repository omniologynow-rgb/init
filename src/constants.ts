/** Shared constants for omniology-init. */

export const MCP_URL = "https://omniology-engine.fly.dev/mcp";
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
export const TERMS_URL = "https://omniology.ai/terms";
export const DASHBOARD_URL = "https://omniology.ai/dashboard";

/** Mainnet USDC mint. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** The npm package the host launches as the local MCP server. */
export const MCP_SERVER_PKG = "@omniology/mcp-server";
/** Spec used in generated configs. @latest so npx always fetches the newest
 *  autonomous server (new tools/fixes) on each host launch; --reconfigure
 *  rewrites existing configs to this too. */
export const MCP_SERVER_SPEC = "@omniology/mcp-server@latest";

/** Docs + download links surfaced to users. */
export const DOCS_URL = "https://omniology.ai/docs";
export const CLAUDE_DOWNLOAD_URL = "https://claude.com/download";

/** Funding thresholds. The engine is the fee payer, so SOL is NOT required to
 *  enter — we gate only on USDC by default (min-sol defaults to 0). */
export const DEFAULT_MIN_SOL = 0;
export const DEFAULT_MIN_USDC = 0.05;

/** Funding poll cadence + ceiling. */
export const FUNDING_POLL_MS = 5_000;
export const FUNDING_TIMEOUT_MS = 10 * 60_000;

/** Suggested first deposit shown to the user (USDC; SOL optional). */
export const SUGGESTED_USDC = 1;

// ── Gated onboarding (v1.4.0) — the unified 6-gate API ────────────────────────

/** Engine base + the unified onboarding API (migration 037). All surfaces
 *  (web wizard, ChatGPT GPT, this CLI) drive the SAME gates in the SAME order. */
export const ENGINE_BASE_URL = "https://omniology-engine.fly.dev";
export const ONBOARD_API_BASE = `${ENGINE_BASE_URL}/api/onboard`;

/** Current Terms-of-Service version string the engine records at gate 1. Kept in
 *  sync with the engine's src/lib/terms.ts TERMS_VERSION. */
export const TERMS_VERSION = "v2.0-adam-approved-2026-06-09";

/** The pinned singleton `vault_authority` PDA every agent approves as its SPL
 *  delegate at gate 5. Derived from the mainnet program id + "vault_authority"
 *  seed. We DECODE the engine-supplied approve tx and assert the delegate equals
 *  this BEFORE signing — a fail-closed guard mirroring the website. NEVER sign an
 *  approve toward any other delegate. */
export const VAULT_AUTHORITY_PINNED = "BQVdEaxjHWFa6Lc7HaeSfHN41YDhQu98LFhFNA32WNxD";

/** Per-entry fee for the text tracks — used in user-facing copy only. */
export const ENTRY_FEE_USDC = 0.01;

/** Gate 3 (email verification) poll cadence + ceiling. */
export const GATE3_POLL_MS = 5_000;
export const GATE3_TIMEOUT_MS = 15 * 60_000;

/** Gate 6 (spending controls) interactive defaults — only used on explicit "yes".
 *  Gate 6 is OPT-IN: the default answer is "no limits". */
export const DEFAULT_DAILY_CAP_USDC = 1.0;
export const DEFAULT_PER_ENTRY_CAP_USDC = 0.05;
/** All competition tracks (matches the engine's ALL_TRACKS). */
export const ALL_TRACKS = ["ART", "STORY", "JOKE", "OMEGA"] as const;
export type Track = (typeof ALL_TRACKS)[number];
