/** Surface registry + dispatch. */
import type { Exec, InstallContext, InstallResult, SurfaceId } from "./types.js";
import * as claudeCode from "./claude-code.js";
import * as cursor from "./cursor.js";
import * as cline from "./cline.js";
import * as openclaw from "./openclaw.js";
import * as cowork from "./cowork.js";
import * as manual from "./manual.js";

export { detectSurfaces, claudeCodeInstalled } from "./detect.js";
export type { SurfaceAvailability } from "./detect.js";

export async function installSurface(
  id: SurfaceId,
  ctx: InstallContext,
  exec?: Exec,
): Promise<InstallResult> {
  switch (id) {
    case "claude-code": return claudeCode.install(ctx, exec);
    case "cursor": return cursor.install(ctx);
    case "cline": return cline.install(ctx);
    case "openclaw": return openclaw.install(ctx, exec);
    case "cowork": return cowork.install(ctx);
    case "manual": return manual.install(ctx);
  }
}
