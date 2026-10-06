import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../.github/scripts/cleanup-stale-actions-processes.sh", import.meta.url));

test("Hub cleanup scopes both test descendants and reaper without changing Actions tracking", () => {
  const suite = readFileSync(new URL("../packages/hub/test/run-suite.mjs", import.meta.url), "utf8");
  const pool = readFileSync(new URL("../packages/hub/test/hub-test-pool.mjs", import.meta.url), "utf8");
  // Every file gets a fresh batch id from the pool, which also records it in
  // the host slot before the task starts; the lane and its cleanup carry it.
  assert.match(pool, /newBatchId = randomUUID/);
  assert.match(pool, /runTask\(file, batchId, /);
  assert.match(suite, /XMATRIX_ACTIONS_CLEANUP_BATCH: batchId/);
  assert.match(suite, /runLaneAsync\(file, 1, \[file\], \{ env: batchEnvironment \}\)/);
  assert.match(suite, /env: \{ \.\.\.process.env, \.\.\.batchEnvironment \}/);
  assert.doesNotMatch(suite, /RUNNER_TRACKING_ID\s*[:=]/);
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);
});

test("current-job cleanup refuses an unspecified batch", () => {
  const env = { ...process.env, RUNNER_TRACKING_ID: `github_${randomUUID()}`, RUNNER_TEMP: tmpdir() };
  delete env.XMATRIX_ACTIONS_CLEANUP_BATCH;
  const result = spawnSync("bash", [script, "--current-orphans"], { env, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires XMATRIX_ACTIONS_CLEANUP_BATCH/);
});

test("Linux reaper removes only its completed batch, preserving shared services and other jobs", {
  skip: process.platform !== "linux" && "requires the Linux /proc cleanup implementation", timeout: 20_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "xmatrix-cleanup-test-"));
  const env = { ...process.env, RUNNER_TRACKING_ID: `github_${randomUUID()}`, RUNNER_TEMP: directory };
  delete env.XMATRIX_ACTIONS_CLEANUP_BATCH;
  const children = [];
  async function start(extra) {
    const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
      env: { ...env, ...extra }, stdio: ["ignore", "pipe", "ignore"],
    });
    const exited = once(child, "exit");
    children.push({ child, exited });
    await once(child.stdout, "data");
    return { child, exited };
  }
  try {
    const shared = await start({});
    const target = await start({ XMATRIX_ACTIONS_CLEANUP_BATCH: "completed-batch" });
    const otherBatch = await start({ XMATRIX_ACTIONS_CLEANUP_BATCH: "other-batch" });
    const otherJob = await start({ XMATRIX_ACTIONS_CLEANUP_BATCH: "completed-batch", RUNNER_TRACKING_ID: `github_${randomUUID()}` });
    const result = spawnSync("bash", [script, "--current-orphans"], {
      env: { ...env, XMATRIX_ACTIONS_CLEANUP_BATCH: "completed-batch" }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Terminating 1 reclaimable/);
    const [, signal] = await target.exited;
    assert.ok(signal === "SIGTERM" || signal === "SIGKILL");
    for (const { child } of [shared, otherBatch, otherJob]) assert.equal(process.kill(child.pid, 0), true);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all(children.map(({ exited }) => exited));
    rmSync(directory, { recursive: true, force: true });
  }
});
