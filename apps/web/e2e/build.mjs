import { spawnSync } from "node:child_process";
import { isCliMain } from "../../../scripts/cli-entrypoint.mjs";

import { WEB_E2E_FIXTURE_ENV } from "./fixture-env.mjs";

// Only the Next child gets browser fixtures. The Turbo parent and sibling unit
// tests keep their original environment. This file and fixture-env.mjs are
// package inputs in Turbo's default hash, including every fixed fixture value.
export function runBrowserBuild({
  env = process.env,
  run = spawnSync,
} = {}) {
  // Keep PNPM's executable shim: it supplies the dependency resolution paths
  // needed by Next's compiled TypeScript config with an isolated PNPM layout.
  const result = run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "next", "build"], {
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
    env: { ...env, ...WEB_E2E_FIXTURE_ENV, NEXT_TEST_WASM: "1" },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (isCliMain(import.meta.url)) {
  process.exitCode = runBrowserBuild();
}
