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
