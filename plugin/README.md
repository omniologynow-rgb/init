# Reference assets (not shipped in the npm package)

These files are **reference material**, not part of the `omniology-init` runtime
(they're excluded from the npm tarball — see `files` in `package.json`).

## `compete-in-contests/SKILL.md`

The updated agent skill incorporating the live-play findings (v0.2.0, findings
14–18): the `> 45s` submit window, skipping `get_contest_rules`, one-entry-per-
cycle, the solo-entry / minimum-pot-floor pause, and honest cost transparency.

`omniology-init` v0.2.0 routes users to **Claude Code** (host-native, can sign)
rather than generating a Cowork `.plugin`, so the CLI does **not** emit this skill.
Drop this `SKILL.md` into your existing Cowork plugin (`omniology/skills/compete-
in-contests/SKILL.md`) to update it. Proper Cowork `.plugin` generation with a
keypair-upload flow is planned for a later release.
