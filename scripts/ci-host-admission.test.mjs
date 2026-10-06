import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireCiHostLease, ciHostHasHeadroom, runAdmittedCiStages, sharedCiCapacity } from "./ci-host-admission.mjs";
import { hostSlotsSupported } from "./host-task-slots.mjs";

const healthy = { idleCpus: 4, cpuPressure: 0, availableBytes: 8 * 1024 ** 3 };
function controlledHost(overrides = {}) {
  let time = 0;
  return {
    platform: "linux", env: {}, cpus: 8, supported: () => true,
    sampleIdle: () => healthy.idleCpus, pressure: () => healthy,
    now: () => time, wait: async (ms) => { time += ms; },
    timeoutMs: 2_000, log: () => {}, ...overrides,
  };
}

test("shared checks require headroom rather than treating steal or missing observations as idle", () => {
  assert.deepEqual([1, 4, 8, 32].map(sharedCiCapacity), [1, 1, 2, 2]);
  assert.equal(ciHostHasHeadroom(healthy, 8), true);
  for (const observation of [
    { idleCpus: 0.7 }, { idleCpus: null }, { cpuPressure: 10 },
    { cpuPressure: null }, { availableBytes: 3 * 1024 ** 3 }, { availableBytes: null },
  ]) assert.equal(ciHostHasHeadroom({ ...healthy, ...observation }, 8), false);
});

test("hosted and non-Linux checks do not probe or consume the shared Linux pool", async () => {
  const supported = () => assert.fail("unexpected flock probe");
  assert.equal(await acquireCiHostLease(controlledHost({ env: { RUNNER_ENVIRONMENT: "github-hosted" }, supported })), null);
  assert.equal(await acquireCiHostLease(controlledHost({ platform: "win32", supported })), null);
});

test("pressure, unavailable flock and a full pool never become unguarded admission", async () => {
  await assert.rejects(acquireCiHostLease(controlledHost({ supported: () => false })), /requires flock/u);
  await assert.rejects(acquireCiHostLease(controlledHost({ sampleIdle: () => null,
    acquire: () => assert.fail("capacity must not be leased without CPU evidence"),
  })), /timed out after 2000ms/u);
  await assert.rejects(acquireCiHostLease(controlledHost({ acquire: () => null })), /timed out/u);
});

test("independent CI runs share a bounded flock pool and a waiting run proceeds after release", {
  skip: !hostSlotsSupported() && "requires Linux flock",
}, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xmatrix-ci-host-test-"));
  const leases = [];
  t.after(() => { for (const lease of leases) lease.release(); rmSync(directory, { recursive: true, force: true }); });
  // Removing a lease from the cleanup list before closing it avoids a double close.
  const first = await acquireCiHostLease(controlledHost({ directory }));
  const second = await acquireCiHostLease(controlledHost({ directory }));
  leases.push(first, second);
  assert.notEqual(first.index, second.index);
  let waited = false;
  const third = await acquireCiHostLease(controlledHost({ directory,
    wait: async () => {
      assert.equal(waited, false, "the blocked run wakes after one slot is released");
      waited = true;
      leases.shift().release();
    },
  }));
  leases.push(third);
  assert.equal(waited, true);
  assert.equal(third.index, first.index);
  assert.notEqual(third.batchId, first.batchId);
});

test("owner loss and cancellation end admission wait before any validation starts", {
  timeout: 10_000, skip: process.platform === "win32" && "POSIX signal semantics; Windows does not use Linux admission",
}, async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { pathToFileURL } = await import("node:url");
  const { setTimeout: delay } = await import("node:timers/promises");
  const moduleUrl = pathToFileURL(path.resolve("scripts/ci-host-admission.mjs")).href;
  const lifecycleUrl = pathToFileURL(path.resolve("scripts/process-tree.mjs")).href;
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); });
  for (const mode of ["signal", "owner"]) {
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(owner);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { runAdmittedCiStages } from ${JSON.stringify(moduleUrl)};
      import { createProcessTreeLifecycle } from ${JSON.stringify(lifecycleUrl)};
      await runAdmittedCiStages([], {
        lifecycle: createProcessTreeLifecycle({ownerPids:[${owner.pid}], pollIntervalMs:10}),
        acquire: async () => { console.log("waiting"); await new Promise(r => setTimeout(r, 30000)); return null; },
        run: async () => { console.log("VALIDATION STARTED"); },
      });
    `], { env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    const closed = once(child, "close");
    while (!output.includes("waiting")) {
      assert.equal(child.exitCode, null, "fixture exited before entering admission");
      await delay(10);
    }
    if (mode === "signal") child.kill("SIGTERM");
    else { owner.kill("SIGKILL"); await once(owner, "close"); }
    const [code] = await closed;
    assert.equal(code, mode === "signal" ? 143 : 1);
    assert.equal(output.includes("VALIDATION STARTED"), false);
    owner.kill("SIGKILL");
  }
});

test("a failed validation retains its exit failure and releases host capacity", {
  skip: !hostSlotsSupported() && "requires Linux flock",
}, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xmatrix-ci-failed-admission-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const acquire = () => acquireCiHostLease(controlledHost({ directory, cpus: 4 }));
  await assert.rejects(runAdmittedCiStages([{
    label: "intentional validation failure", command: process.execPath,
    args: ["-e", "process.exit(17)"], env: process.env,
  }], { acquire }), /exit code=17/u);
  const availableAgain = await acquire();
  assert.ok(availableAgain);
  availableAgain.release();
});

test("capacity recovering at the deadline is refused, including a lease acquired across it", async () => {
  for (const crossesDuringAcquire of [false, true]) {
    let time = 0;
    let released = 0;
    let acquisitions = 0;
    await assert.rejects(acquireCiHostLease(controlledHost({
      now: () => time,
      sampleIdle: () => crossesDuringAcquire || time >= 2000 ? 4 : 0,
      wait: async (ms) => { time += ms; },
      acquire: () => {
        acquisitions += 1;
        time = 2000;
        return { index: 0, release: () => { released += 1; } };
      },
    })), /timed out after 2000ms/u);
    assert.equal(acquisitions, crossesDuringAcquire ? 1 : 0);
    assert.equal(released, crossesDuringAcquire ? 1 : 0);
  }
});
