import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../.github/scripts/rust-compile-jobs.sh", import.meta.url));

function jobs(availableGiB, processors, runnerEnvironment = "self-hosted") {
  const meminfo = path.join(mkdtempSync(path.join(os.tmpdir(), "xmatrix-rust-jobs-")), "meminfo");
  writeFileSync(meminfo, `MemTotal: 99999999 kB\nMemAvailable: ${availableGiB * 1024 * 1024} kB\n`);
  const result = spawnSync("bash", [script, meminfo, String(processors)], {
    encoding: "utf8",
    env: { ...process.env, RUNNER_ENVIRONMENT: runnerEnvironment },
  });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

test("on a shared machine Rust compile parallelism is a quarter of the processors", { skip: process.platform === "win32" }, () => {
  assert.equal(jobs(64, 32), 8);
  assert.equal(jobs(64, 8), 2);
});

test("a GitHub-hosted runner compiles on every processor it has", { skip: process.platform === "win32" }, () => {
  assert.equal(jobs(6.5, 2, "github-hosted"), 2);
  assert.equal(jobs(14, 4, "github-hosted"), 4);
});

test("Rust compile parallelism reserves 3 GiB of available memory per rustc", { skip: process.platform === "win32" }, () => {
  assert.equal(jobs(15, 32), 5);
  assert.equal(jobs(8, 32), 2);
  assert.equal(jobs(5, 4, "github-hosted"), 1);
});

test("Rust compile parallelism never drops below one compiler", { skip: process.platform === "win32" }, () => {
  assert.equal(jobs(2, 32), 1);
  assert.equal(jobs(64, 2), 1);
});
