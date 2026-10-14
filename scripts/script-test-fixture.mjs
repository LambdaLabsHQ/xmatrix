import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
export { assert };
export { default as test } from "node:test";
export { execFileSync, spawnSync };
export { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
export { tmpdir } from "node:os";
export { fileURLToPath } from "node:url";
export { default as os } from "node:os";
export { fs, path };
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const readRepoFile = (relative) => fs.readFileSync(path.join(rootDir, relative), "utf8");

// Detached `gc` / `maintenance` keeps writing `.git/objects/pack` after git returns.
// Node's recursive rm then fails the test hook with ENOTEMPTY: its retry only
// repeats rmdir and never picks up a file that appeared after the first listing.
const detachedGitMaintenance = [
  ["gc.auto", "0"],
  ["gc.autoDetach", "false"],
  ["maintenance.auto", "false"],
  ["maintenance.autoDetach", "false"],
  ["receive.autogc", "false"],
];

export function disableDetachedGitMaintenance(cwd) {
  for (const [key, value] of detachedGitMaintenance) {
    execFileSync("git", ["config", key, value], { cwd, stdio: "pipe" });
  }
}

export function gitMaintenanceCloneArgs() {
  return detachedGitMaintenance.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

const temporaryRemovalRetries = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

export function removeTemporaryDirectory(directory) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!temporaryRemovalRetries.has(error?.code) || attempt === 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

export function finishDaemonHarness(workDir, callLog, result) {
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "";
  fs.rmSync(workDir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

export function assertExistingDaemonLogin(run) {
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.calls, /whoami/);
  assert.doesNotMatch(run.calls, /login/);
}
