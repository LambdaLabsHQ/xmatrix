import { spawnSync } from "node:child_process";
import { runCliMain } from "./cli-entrypoint.mjs";

export function checkReleaseVersion({ run = spawnSync, env = process.env } = {}) {
  const checks = [
    ["scripts/version.mjs", "check"],
    ["scripts/production-release-policy.mjs", "verify-remote-tag", env.GITHUB_REF_NAME ?? "", env.GITHUB_SHA ?? ""],
    // The train already chose an ascending version before it cut this tag.
    // A component may start after a newer parallel train: prove its frozen
    // checkout, rather than treating that later tag as a new release floor.
    ["scripts/production-release-policy.mjs", "validate-checkout", env.GITHUB_REF_NAME ?? ""],
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
