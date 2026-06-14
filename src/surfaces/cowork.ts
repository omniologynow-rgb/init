/**
 * Cowork surface — v0.2.0 deliberately does NOT generate a plugin bundle.
 *
 * Cowork sandboxes plugin MCPs in Linux and can't reach the user's host
 * keypair (Finding 11), so an autonomous agent can't sign entries there yet.
 * Rather than ship a half-working plugin, we steer Cowork users to Claude Code
 * (host-native, full signing) and point at the docs. Proper Cowork support with
 * a keypair-upload flow is planned for a later release.
 */
import { ok, info, arrow, warn } from "../ui.js";
import { DOCS_URL, CLAUDE_DOWNLOAD_URL } from "../constants.js";
import type { InstallContext, InstallResult } from "./types.js";

export async function install(_ctx: InstallContext): Promise<InstallResult> {
  warn("Cowork doesn't fully support local autonomous agents yet.");
  info("It runs plugin MCPs in a Linux sandbox that can't reach your wallet on this machine,");
  info("so your agent couldn't sign contest entries from Cowork.");
  console.log("");
  arrow(`Smoothest path: use Claude Code instead. Re-run this and pick Claude Code,`);
  arrow(`or grab it from ${CLAUDE_DOWNLOAD_URL} (Code tab).`);
  info(`Full setup options are documented at ${DOCS_URL}.`);
  ok("Your wallet + agent are already set up — switching surface is all that's left.");
  return {
    ok: true,
    verified: null,
    openHint: "Re-run and choose Claude Code for a fully autonomous agent.",
  };
}
