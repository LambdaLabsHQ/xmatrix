import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

import { createProcessTreeLifecycle } from "./process-tree.mjs";
import { runProgressStages } from "./ci-progress.mjs";
import { dedicatedMachine } from "./ci-machine.mjs";
import { batchProcesses, hostSlotsSupported, tryAcquireHostSlot } from "./host-task-slots.mjs";
import { createIdleCpuSampler, readHostPressure } from "../packages/hub/test/hub-test-resources.mjs";

export const CI_HOST_BATCH_ENV = "XMATRIX_CI_HOST_BATCH";
const GIB = 1024 ** 3;

export function sharedCiCapacity(cpus) {
  if (!Number.isSafeInteger(cpus) || cpus <= 0) throw new Error("CI CPU capacity must be a positive integer");
  return Math.max(1, Math.min(2, Math.floor(cpus / 4)));
}

export function ciHostHasHeadroom({ idleCpus, cpuPressure, availableBytes }, cpus) {
  // Unknown CPU or memory observations do not authorize extra work. This is
  // admission, not a quota: an admitted process tree always runs to completion.
  return Number.isFinite(idleCpus) && idleCpus >= Math.min(2, cpus)
    && Number.isFinite(cpuPressure) && cpuPressure < 10
    && Number.isFinite(availableBytes) && availableBytes >= 4 * GIB;
}

export async function acquireCiHostLease({
  platform = process.platform,
  env = process.env,
  cpus = os.availableParallelism(),
  directory = path.join(os.homedir(), ".cache", "xmatrix", "ci-host-slots"),
  supported = hostSlotsSupported,
  sampleIdle = createIdleCpuSampler({ cpuCount: cpus }),
  pressure = readHostPressure,
  acquire = tryAcquireHostSlot,
  scan = (batchId) => batchProcesses(batchId, { batchEnv: CI_HOST_BATCH_ENV }),
  now = () => performance.now(),
  wait = delay,
  timeoutMs = 20 * 60_000,
  log = console.log,
} = {}) {
  if (platform !== "linux" || dedicatedMachine(env)) return null;
  if (!supported(platform)) throw new Error("Shared Linux CI requires flock host admission");
  const batchId = randomUUID();
  const count = sharedCiCapacity(cpus);
  const started = now();
  let lastLog = -Infinity;
  const checkDeadline = (observed, lease) => {
    const elapsed = now() - started;
    if (elapsed >= timeoutMs) {
      lease?.release();
      throw new Error(`Shared CI host admission timed out after ${Math.round(elapsed)}ms: ${JSON.stringify(observed)}`);
    }
    return elapsed;
  };
  for (;;) {
    const observed = { ...pressure(), idleCpus: sampleIdle() };
    const elapsed = checkDeadline(observed);
    if (ciHostHasHeadroom(observed, cpus)) {
      const lease = acquire({ batchId, count, directory, scan });
      if (lease) {
        checkDeadline(observed, lease);
        log(`[ci-host] admitted slot=${lease.index}/${count} batch=${batchId}`);
        return { ...lease, batchId };
      }
    }
    if (elapsed - lastLog >= 30_000) {
      log(`[ci-host] waiting for capacity (${count} slots): ${JSON.stringify(observed)}`);
      lastLog = elapsed;
    }
    await wait(Math.min(1_000, timeoutMs - elapsed));
  }
}

export async function runAdmittedCiStages(stages, {
  acquire = acquireCiHostLease,
  lifecycle = createProcessTreeLifecycle(),
  run = runProgressStages,
} = {}) {
  // Monitor the original owner before admission starts: cancellation or a dead
  // Worker must not leave a waiter that later starts an orphaned validation.
  lifecycle.start();
  let lease;
  try {
    lease = await acquire();
    if (lease) {
      process.on("exit", lease.release);
      stages = stages.map((stage) => ({
        ...stage, env: { ...stage.env, [CI_HOST_BATCH_ENV]: lease.batchId },
      }));
    }
    await run(stages, { prefix: "ci", lifecycle });
  } finally {
    lifecycle.cleanup();
    lifecycle.dispose();
    if (lease) {
      process.off("exit", lease.release);
      lease.release();
    }
  }
}
