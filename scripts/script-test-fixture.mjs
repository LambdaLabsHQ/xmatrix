import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
export { assert };
export { default as test } from "node:test";
export { spawnSync, execFileSync } from "node:child_process";
export { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
export { tmpdir } from "node:os";
export { fileURLToPath } from "node:url";
export { default as os } from "node:os";
export { fs, path };
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const readRepoFile = (relative) => fs.readFileSync(path.join(rootDir, relative), "utf8");

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
