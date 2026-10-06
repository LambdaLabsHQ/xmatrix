import assert from "node:assert/strict";
import test from "node:test";

import {
  HUB_TEST_ADAPTIVE_IDLE_CPUS,
  HUB_TEST_ADAPTIVE_MAX_CPU_PRESSURE,
  HUB_TEST_ADAPTIVE_MIN_AVAILABLE_BYTES,
  HUB_TEST_ADAPTIVE_SETTLE_MS,
  HUB_TEST_DEFAULT_HOST_SLOTS,
  HUB_TEST_MEMORY_PER_SLOT,
  createIdleCpuSampler,
  planHubTestResources,
  readHostPressure,
  shouldRunHubBatchProcessCleanup,
  shouldStartAnotherHubFile,
} from "./hub-test-resources.mjs";

const GIB = 1024 ** 3;
const fdLimits = { soft: 4096, hard: 4096 };

test("Hub auto concurrency floors at half the cores and may grow to the adaptive ceiling", () => {
  for (const [cpuConcurrency, floor, ceiling] of [
    [1, 1, 1],
    [3, 1, 3],
    [4, 2, 4],
    [8, 4, 8],
    [32, 16, HUB_TEST_DEFAULT_HOST_SLOTS],
    [64, 32, 32],
  ]) {
    const plan = planHubTestResources({
      cpuConcurrency,
      memoryBytes: 64 * GIB,
      fdLimits: { soft: 1 << 20, hard: 1 << 20 },
    });

    assert.equal(plan.concurrency, floor);
    assert.equal(plan.halfCpuConcurrency, floor);
    assert.equal(plan.maxConcurrency, ceiling);
    assert.equal(plan.constrainedBy, "half-cpu");
  }
});

test("Hub descriptor budget covers the adaptive ceiling, not just the floor", () => {
  const plan = planHubTestResources({ cpuConcurrency: 32, memoryBytes: 64 * GIB, fdLimits: { soft: 1 << 20, hard: 1 << 20 } });
  const required = 256 + HUB_TEST_DEFAULT_HOST_SLOTS * 256;
  assert.equal(plan.requiredFdLimit, required);
  assert.throws(
    () => planHubTestResources({ cpuConcurrency: 32, memoryBytes: 64 * GIB, fdLimits: { soft: 4096, hard: 4096 } }),
    new RegExp(`hard limit of at least ${required} for concurrency=${HUB_TEST_DEFAULT_HOST_SLOTS}`, "u"),
  );
});

test("every suite on a host derives the same shared slot count", () => {
  const auto = planHubTestResources({ cpuConcurrency: 32, memoryBytes: 64 * GIB, fdLimits: { soft: 1 << 20, hard: 1 << 20 } });
  const explicit = planHubTestResources({ requestedConcurrency: 4, cpuConcurrency: 32, memoryBytes: 64 * GIB, fdLimits });
  assert.equal(auto.hostSlots, HUB_TEST_DEFAULT_HOST_SLOTS);
  assert.equal(explicit.hostSlots, auto.hostSlots);
  const wider = planHubTestResources({ hostSlotSetting: 30, cpuConcurrency: 32, memoryBytes: 64 * GIB, fdLimits: { soft: 1 << 20, hard: 1 << 20 } });
  assert.equal(wider.hostSlots, 30);
  assert.equal(wider.maxConcurrency, 30);
  assert.equal(planHubTestResources({ hostSlotSetting: 30, cpuConcurrency: 8, memoryBytes: 64 * GIB, fdLimits }).hostSlots, 8,
    "never more slots than logical CPUs");
  assert.throws(() => planHubTestResources({ hostSlotSetting: 0, cpuConcurrency: 8, memoryBytes: 64 * GIB, fdLimits }),
    /host slots must be a positive integer/u);
});

test("Hub explicit concurrency is fixed", () => {
  const plan = planHubTestResources({
    requestedConcurrency: 3,
    cpuConcurrency: 32,
    memoryBytes: 64 * GIB,
    fdLimits,
  });
  assert.equal(plan.concurrency, 3);
  assert.equal(plan.maxConcurrency, 3);
  assert.equal(plan.constrainedBy, "explicit");
});

test("Hub auto concurrency retains the static memory cap", () => {
  const memoryBytes = 4 * GIB;
  const plan = planHubTestResources({
    cpuConcurrency: 32,
    memoryBytes,
    fdLimits,
  });

  const reserveBytes = Math.max(GIB, Math.floor(memoryBytes / 8));
  assert.equal(
    plan.concurrency,
    Math.floor((memoryBytes - reserveBytes) / HUB_TEST_MEMORY_PER_SLOT),
  );
  assert.equal(plan.halfCpuConcurrency, 16);
  assert.equal(plan.maxConcurrency, plan.concurrency);
  assert.equal(plan.constrainedBy, "memory");
});

test("the idle-CPU sampler measures the interval between calls from shared kernel counters", () => {
  const snapshots = [
    "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3",
    // 1000 more jiffies, 600 of them idle or iowait: 60% of 32 CPUs idle.
    "cpu  300 0 300 1300 100 0 0 0 0 0\ncpu0 1 2 3",
    "not a stat file",
  ];
  const sample = createIdleCpuSampler({ cpuCount: 32, readStat: () => snapshots.shift() });
  assert.equal(sample(), null, "the first call only primes the counters");
  assert.equal(Math.round(sample() * 10) / 10, 19.2);
  assert.equal(sample(), null, "unreadable counters never widen the pool");
  const unavailable = createIdleCpuSampler({ readStat: () => { throw new Error("no /proc"); } });
  assert.equal(unavailable(), null);
});

test("the Hub pool widens above its floor only on sustained idle CPUs", () => {
  const base = { floor: 8, max: 20, idleCpus: 10, msSinceLastStart: HUB_TEST_ADAPTIVE_SETTLE_MS };
  assert.equal(shouldStartAnotherHubFile({ ...base, running: 7, idleCpus: 0 }), true, "the floor always runs");
  assert.equal(shouldStartAnotherHubFile({ ...base, running: 7, idleCpus: null }), true, "even without counters");
  assert.equal(shouldStartAnotherHubFile({ ...base, running: 8 }), true);
  assert.equal(shouldStartAnotherHubFile({ ...base, running: 20 }), false, "never past the ceiling");
  assert.equal(shouldStartAnotherHubFile({ ...base, running: 8, idleCpus: HUB_TEST_ADAPTIVE_IDLE_CPUS - 0.1 }), false);
  assert.equal(shouldStartAnotherHubFile({ ...base, running: 8, idleCpus: null }), false, "no counters, no growth");
  assert.equal(shouldStartAnotherHubFile({ ...base, running: 8, msSinceLastStart: HUB_TEST_ADAPTIVE_SETTLE_MS - 1 }), false,
    "a new file ramps up before the next start");
});

test("Hub batch orphan cleanup runs only on Linux", () => {
  assert.equal(shouldRunHubBatchProcessCleanup("linux"), true);
  assert.equal(shouldRunHubBatchProcessCleanup("win32"), false);
  assert.equal(shouldRunHubBatchProcessCleanup("darwin"), false);
});

test("growth above the floor also waits out CPU pressure and low memory", () => {
  const base = { running: 8, floor: 8, max: 30, idleCpus: 10, msSinceLastStart: 5_000 };
  assert.equal(shouldStartAnotherHubFile({ ...base, cpuPressure: 3.6, availableBytes: 21 * GIB }), true);
  assert.equal(shouldStartAnotherHubFile({ ...base, cpuPressure: HUB_TEST_ADAPTIVE_MAX_CPU_PRESSURE }), false,
    "a loaded host keeps the suite where it is even with idle CPUs showing");
  assert.equal(shouldStartAnotherHubFile({ ...base, availableBytes: HUB_TEST_ADAPTIVE_MIN_AVAILABLE_BYTES - 1 }), false);
  assert.equal(shouldStartAnotherHubFile({ ...base, cpuPressure: null, availableBytes: null }), true,
    "hosts without PSI fall back to the idle-CPU gate");
  assert.equal(shouldStartAnotherHubFile({ ...base, running: 7, cpuPressure: 90, availableBytes: 1 }), true,
    "the floor runs regardless");
});

test("host pressure is read from PSI and meminfo, and absent counters read as unknown", () => {
  const sample = readHostPressure({
    readPressure: () => "some avg10=25.40 avg60=12.22 avg300=8.16 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
    readMeminfo: () => "MemTotal:       49152000 kB\nMemAvailable:   5242880 kB\n",
  });
  assert.deepEqual(sample, { cpuPressure: 25.4, availableBytes: 5 * GIB });
  assert.deepEqual(readHostPressure({
    readPressure: () => { throw new Error("no psi"); },
    readMeminfo: () => "garbage",
  }), { cpuPressure: null, availableBytes: null });
});

test("a job with its machine to itself runs a Hub file per logical CPU", () => {
  const fdLimits = { soft: 1 << 20, hard: 1 << 20 };
  const dedicated = planHubTestResources({ dedicated: true, cpuConcurrency: 2, memoryBytes: 8 * GIB, fdLimits });
  assert.equal(dedicated.concurrency, 2);
  assert.equal(dedicated.constrainedBy, "dedicated-cpu");
  assert.equal(dedicated.dedicated, true);
  const shared = planHubTestResources({ cpuConcurrency: 2, memoryBytes: 8 * GIB, fdLimits });
  assert.equal(shared.concurrency, 1);
  assert.equal(shared.dedicated, false);
});
