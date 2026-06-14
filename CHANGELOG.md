# Changelog

## 0.2.1 — fix `npx` invocation

- **Finding 21:** `npx @omniology/init` failed with `omniology-init: not found`
  because npx runs the binary matching the package's last name segment (`init`),
  but the bin map only had `omniology-init`. (Global install worked fine, proving
  the package itself was correct.)
- **Fix:** added `init` as a bin alias alongside `omniology-init`, so all forms
  work: `npx @omniology/init` (friendly), `npx -p @omniology/init omniology-init`
  (explicit), and `omniology-init` (global install).

## 0.2.0 — surface-aware install (reality-aligned after live testing)

A live caveman test on Windows surfaced 18 findings. The wallet / funding /
registration flow worked perfectly and is unchanged. The final "write config"
step was rebuilt because the **new unified Claude app no longer reads
`claude_desktop_config.json`**. v0.2.0 detects which surface you have and routes
the install correctly.

### Highlights
- **Dropped the legacy `claude_desktop_config.json` path.** It is not read by the
  new unified Claude app (Chat + Cowork + Code in one).
- **New "Where do you want to run your agent?" question** with auto-detected
  options — Claude Code (recommended), Cursor, Cline, Cowork, Manual.
- **Claude Code**: registered via `claude mcp add omniology --scope user …`
  (global across projects) and verified with `claude mcp list`.
- **Cursor / Cline**: atomic config write that preserves existing servers.
- **Cowork**: not yet supported (sandboxed Linux plugins can't reach your local
  wallet) — init recommends Claude Code instead.
- **Manual**: prints the exact config + per-host pointers.
- **Windows path fix**: keypair paths are stored with forward slashes, which
  survive shell/CLI handling (backslashes were being stripped) and are valid for
  both Node and the Linux MCP runtime.
- Pinned the connector to `@omniology/mcp-server@2.0.0` (autonomous signing).

### The 18 findings driving this release
1. The new unified Claude app (claude.com/download) merges Chat, Cowork, and Code;
   the legacy `claude_desktop_config.json` is no longer read.
2. Chat mode supports **remote** MCPs only (URL connectors) — no local stdio.
3. Cowork has a plugin system (Customize → Personal Plugins → Upload `.plugin`).
4. Code mode is Claude Code, which has **native stdio MCP support** — the right
   home for our local autonomous MCP (`claude mcp add` / `~/.claude.json`).
5. Engine "launch hardening" banner can pause mainnet entries (Matt-controlled;
   out of init's scope).
6. Without an MCP loaded, Claude falls back to web search and refuses to spend
   USDC (safety guardrail). With the autonomous MCP loaded, no refusal.
7. Cowork "Personal Plugins" expects packaged `.plugin` bundles, not a raw MCP add.
8. Cowork has a plugin marketplace — a distribution opportunity for later.
9. Plugin `.mcp.json` format matches the standard MCP config (command/args/env).
10. Plugin skills can prime Claude ("the MCP signs internally; just call the
    tools; don't refuse on signing grounds").
11. **Cowork plugin MCPs run in a Linux sandbox** — Windows host paths are
    unreachable, so the autonomous MCP can't read the keypair from Cowork. v0.2.0
    routes Cowork users to Claude Code instead.
12. The "Add custom connector" dialog is universal across modes and accepts remote
    URLs only — local stdio MCPs must be added via the Claude Code CLI.
13. `claude mcp add` defaults to project scope; we use `--scope user` for global
    availability across working directories.
14. Contests surface with ~48–51s remaining (engine enter-guard), not the full
    88s cycle.
15. The skill's old `>55s` safety threshold is unreachable; changed to `>45s`.
16. Parallel `submit_entry` calls get serialized — only the first lands. Pattern:
    one entry per cycle.
17. Solo entries (no other entrants) earn $0 even when winning (pot below the
    ~$0.03 minimum-payout floor). The skill now pauses to ask the user before
    spending on guaranteed-loss rounds.
18. Claude learns strategy organically from tool feedback — the skill stays light
    and lets it adapt.

> Findings 14–18 update the **agent skill** (`plugin/compete-in-contests/SKILL.md`,
> a repo reference asset). Since v0.2.0 routes Cowork users to Claude Code rather
> than generating a `.plugin`, the CLI no longer emits the skill; apply the
> updated `SKILL.md` to your existing plugin manually.

## 0.1.0 — initial release
Wallet generation, fund-once flow (QR), agent registration, and host config write
(Claude Desktop / Cursor / Cline / manual). No telemetry.
