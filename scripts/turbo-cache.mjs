import os from "node:os";
import path from "node:path";
import process from "node:process";

// CI checkouts are cleaned between jobs, so keep the content-addressed local
// cache in the runner home. Developers retain Turbo's worktree-shared default.
export const turboCacheDir =
  process.env.XMATRIX_TURBO_CACHE_DIR ||
  (process.env.CI ? path.join(os.homedir(), ".cache", "xmatrix", "turbo") : null);

/** Arguments that point a `turbo run` at the shared cache, when there is one. */
export function turboCacheArgs() {
  return turboCacheDir ? [`--cache-dir=${turboCacheDir}`] : [];
}
