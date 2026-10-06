import { spawnSync } from "node:child_process";
import { runCliMain } from "./cli-entrypoint.mjs";

export function checkReleaseVersion({ run = spawnSync, env = process.env } = {}) {
  const checks = [
    ["scripts/version.mjs", "check"],
    ["scripts/production-release-policy.mjs", "verify-remote-tag", env.GITHUB_REF_NAME ?? "", env.GITHUB_SHA ?? ""],
    ["scripts/version.mjs", "check-release-order", "--require-new-version"],
  ];
  for (const args of checks) {
    const result = run(process.execPath, args, { env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

await runCliMain(import.meta.url, async () => {
  process.exitCode = checkReleaseVersion();
});
