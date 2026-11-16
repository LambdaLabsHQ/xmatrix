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
  //
  // Drop NEXT_TEST_WASM. Next treats it as a force-wasm switch: on linux/x64
  // it warns that wasm is not an option for a supported platform, then still
  // loads @next/swc-wasm-nodejs and refuses the native binding. Production
  // `next build` and OpenNext do not set it, so this gate uses that native
  // binding even when a parent process inherited the switch.
  const childEnv = { ...env, ...WEB_E2E_FIXTURE_ENV };
  delete childEnv.NEXT_TEST_WASM;
  const result = run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "next", "build"], {
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
    env: childEnv,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (isCliMain(import.meta.url)) {
  process.exitCode = runBrowserBuild();
}
