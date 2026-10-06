import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import process from "node:process";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// A Hub test slot can own a Node test child, Wrangler, Workerd, SQLite/R2
// handles and test sockets at the same time. This is deliberately a capacity
// budget rather than an observed average: CreateProcess must never discover
// that the host's soft limit was too small halfway through the suite.
export const HUB_TEST_FD_BASELINE = 256;
export const HUB_TEST_FD_PER_SLOT = 256;
export const HUB_TEST_MIN_FD_LIMIT = 4096;
// An initial planning estimate, not a measurement per file: while four Hub
// shards ran on the Workstation (2026-09-27), each 8-worker shard held about
// 9-11 GiB of resident memory, including shared pages and the job's fixed
// processes. Some files need more. Calibrate from cgroup memory.peak or PSS.
export const HUB_TEST_MEMORY_PER_SLOT = 1280 * MIB;
// Any new file, the floor included, waits while the host has less than this
// available. Like the growth gates, this is a sampled admission condition, not
// a reservation: several suites can pass it in the same instant.
export const HUB_TEST_MIN_ADMISSION_AVAILABLE_BYTES = 4 * GIB;
// Every Hub suite on a machine shares this many host slots (hub-test-slots.mjs),
// one per running test file; a file fans out into Wrangler, Workerd and
// esbuild. On the 32-thread Workstation both shards together ran green at
// 20, 24 and 30 slots (2026-09-27). With CPU headroom, 30 was the fastest.
// Under heavy host load, growth past 20 only added contention and took
// available memory down to 5 GiB, which the pressure and memory gates below
// now stop. It is a configured default, not a proven capacity;
// XMATRIX_HUB_TEST_HOST_SLOTS overrides it.
export const HUB_TEST_DEFAULT_HOST_SLOTS = 30;
// Above its floor the pool starts another file only while at least this many
// logical CPUs sat idle over the last sample: a running Hub file keeps one to
// two CPUs busy once Workerd is up.
export const HUB_TEST_ADAPTIVE_IDLE_CPUS = 3;
// After starting a file above the floor, let it ramp up before the next
// sample may start another, so one idle reading cannot fan out a burst.
export const HUB_TEST_ADAPTIVE_SETTLE_MS = 1_000;
// Idle CPUs alone did not tell a loaded host from a quiet one: under heavy
// load the Workstation still showed idle CPUs while runnable tasks waited
// (CPU pressure averaging 25% versus 4% when quiet). Growth above the floor
// needs at least this much available memory. CPU pressure (PSI "some" avg10)
// below this threshold is required for all admission, including the floor.
export const HUB_TEST_ADAPTIVE_MAX_CPU_PRESSURE = 10;
export const HUB_TEST_ADAPTIVE_MIN_AVAILABLE_BYTES = 8 * GIB;

function parseLimit(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "unlimited" || normalized === "infinity") return Infinity;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function readPosixFileDescriptorLimits({
  platform = process.platform,
  run = spawnSync,
} = {}) {
  if (platform === "win32") return undefined;
  const result = inspectPosixResource(run, "/bin/sh", ["-c", "ulimit -Sn; ulimit -Hn"],
    "Unable to inspect the POSIX file-descriptor limit");
  const [softRaw, hardRaw] = String(result.stdout || "").trim().split(/\s+/);
  const soft = parseLimit(softRaw);
  const hard = parseLimit(hardRaw);
  if (soft === undefined || hard === undefined) {
    throw new Error(
      `Unable to parse POSIX file-descriptor limits (soft=${softRaw || "missing"}, hard=${hardRaw || "missing"})`
    );
  }
  return { soft, hard };
}

function readLinuxCgroupMemoryLimit() {
  if (process.platform !== "linux") return undefined;
  for (const file of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      if (raw === "max") continue;
      const value = Number(raw);
      // cgroup v1 represents unlimited memory with a huge sentinel value.
      if (Number.isSafeInteger(value) && value > 0 && value < 2 ** 60) return value;
    } catch {
      // The host is not using this cgroup layout.
    }
  }
  return undefined;
}

/** Effective host RAM (optionally capped by cgroup). Static budget — not live free-memory probing. */
export function effectiveMemoryBytes() {
  const hostBytes = totalmem();
  const cgroupBytes = readLinuxCgroupMemoryLimit();
  return cgroupBytes ? Math.min(hostBytes, cgroupBytes) : hostBytes;
}

/**
 * Auto concurrency is a floor of half the logical CPUs (at least 1) that
 * runs when admission permits, and a ceiling the pool may grow to while the host has idle
 * CPUs (see shouldStartAnotherHubFile). A job with its machine to itself (a
 * GitHub-hosted runner, scripts/ci-machine.mjs) has no other job to leave
 * room for, so its floor is every logical CPU. Both stay within the static
 * RAM budget; an explicit concurrency is fixed.
 */
export function planHubTestResources({
  requestedConcurrency = "auto",
  dedicated = false,
  hostSlotSetting = HUB_TEST_DEFAULT_HOST_SLOTS,
  cpuConcurrency = availableParallelism(),
  memoryBytes = effectiveMemoryBytes(),
  fdLimits = readPosixFileDescriptorLimits(),
} = {}) {
  if (!Number.isSafeInteger(cpuConcurrency) || cpuConcurrency <= 0) {
    throw new Error("Hub test CPU concurrency must be a positive integer");
  }
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) {
    throw new Error("Hub test memory capacity must be a positive number");
  }

  const reserveBytes = Math.max(GIB, Math.floor(memoryBytes / 8));
  const schedulableBytes = Math.max(0, memoryBytes - reserveBytes);
  const memoryConcurrency = Math.floor(schedulableBytes / HUB_TEST_MEMORY_PER_SLOT);
  if (memoryConcurrency < 1) {
    throw new Error(
      `Hub tests require at least ${formatBytes(HUB_TEST_MEMORY_PER_SLOT + reserveBytes)} of memory `
      + `(detected ${formatBytes(memoryBytes)})`
    );
  }

  // The whole suite runs as one job, so its floor is what two quarter-CPU
  // shards used to hold together; host slots still bound every suite.
  const halfCpuConcurrency = Math.max(1, Math.floor(cpuConcurrency / 2));

  const shareConcurrency = dedicated ? cpuConcurrency : halfCpuConcurrency;

  let concurrency;
  let constrainedBy;
  if (requestedConcurrency === "auto") {
    concurrency = Math.min(shareConcurrency, memoryConcurrency);
    constrainedBy = concurrency === memoryConcurrency && memoryConcurrency < shareConcurrency
      ? "memory"
      : dedicated ? "dedicated-cpu" : "half-cpu";
  } else {
    concurrency = Number(requestedConcurrency);
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new Error("--test-concurrency must be 'auto' or a positive integer");
    }
    if (concurrency > memoryConcurrency) {
      throw new Error(
        `Requested Hub test concurrency ${concurrency} exceeds the RAM capacity ${memoryConcurrency} `
        + `(${formatBytes(memoryBytes)} effective memory, ${formatBytes(HUB_TEST_MEMORY_PER_SLOT)} per slot)`
      );
    }
    constrainedBy = "explicit";
  }

  if (!Number.isSafeInteger(hostSlotSetting) || hostSlotSetting <= 0) {
    throw new Error("Hub host slots must be a positive integer");
  }
  // Computed from the host alone, so every suite on one machine agrees on the
  // number of shared slots whatever concurrency it requested.
  const hostSlots = Math.min(hostSlotSetting, cpuConcurrency, memoryConcurrency);
  const maxConcurrency = requestedConcurrency === "auto" ? Math.max(concurrency, hostSlots) : concurrency;

  const requiredFdLimit = Math.max(
    HUB_TEST_MIN_FD_LIMIT,
    HUB_TEST_FD_BASELINE + maxConcurrency * HUB_TEST_FD_PER_SLOT
  );
  if (fdLimits && Number.isFinite(fdLimits.hard) && fdLimits.hard < requiredFdLimit) {
    throw new Error(
      `Hub tests need a file-descriptor hard limit of at least ${requiredFdLimit} for concurrency=${maxConcurrency}, `
      + `but this host is capped at ${fdLimits.hard}. Raise the host hard limit; the runner will not hide this `
      + "capacity failure by silently lowering concurrency."
    );
  }

  return {
    concurrency,
    maxConcurrency,
    hostSlots,
    constrainedBy,
    dedicated,
    cpuConcurrency,
    halfCpuConcurrency,
    memoryBytes,
    memoryConcurrency,
    fdLimits,
    requiredFdLimit,
  };
}

/**
 * Idle logical CPUs over the interval since the previous call, from the
 * host-wide /proc/stat counters every job on the machine shares. Returns null
 * for the first call and wherever the counters are unavailable (non-Linux).
 */
export function createIdleCpuSampler({
  cpuCount = availableParallelism(),
  readStat = () => readFileSync("/proc/stat", "utf8"),
} = {}) {
  let previous = null;
  return function sampleIdleCpus() {
    let fields;
    try {
      fields = readStat().split("\n", 1)[0].trim().split(/\s+/u).slice(1, 9).map(Number);
    } catch {
      return null;
    }
    if (fields.length < 5 || fields.some((value) => !Number.isFinite(value))) return null;
    // user nice system idle iowait irq softirq steal; guest time is already in user.
    const current = { idle: fields[3] + fields[4], total: fields.reduce((sum, value) => sum + value, 0) };
    const last = previous;
    previous = current;
    if (!last || current.total <= last.total) return null;
    return ((current.idle - last.idle) / (current.total - last.total)) * cpuCount;
  };
}

/**
 * The host's CPU pressure (PSI "some" avg10, percent) and available memory,
 * each null where the kernel does not report it.
 */
export function readHostPressure({
  readPressure = () => readFileSync("/proc/pressure/cpu", "utf8"),
  readMeminfo = () => readFileSync("/proc/meminfo", "utf8"),
} = {}) {
  let cpuPressure = null;
  let availableBytes = null;
  try {
    const value = Number(readPressure().match(/^some avg10=([0-9.]+)/mu)?.[1]);
    if (Number.isFinite(value)) cpuPressure = value;
  } catch {
    // No PSI on this kernel.
  }
  try {
    const kib = Number(readMeminfo().match(/^MemAvailable:\s+(\d+) kB$/mu)?.[1]);
    if (Number.isFinite(kib)) availableBytes = kib * 1024;
  } catch {
    // No /proc/meminfo.
  }
  return { cpuPressure, availableBytes };
}

/** Whether the Hub pool should start one more file now. */
export function shouldStartAnotherHubFile({
  running,
  floor,
  max,
  idleCpus,
  msSinceLastStart,
  cpuPressure = null,
  availableBytes = null,
  minIdleCpus = HUB_TEST_ADAPTIVE_IDLE_CPUS,
  settleMs = HUB_TEST_ADAPTIVE_SETTLE_MS,
  maxCpuPressure = HUB_TEST_ADAPTIVE_MAX_CPU_PRESSURE,
  minAvailableBytes = HUB_TEST_ADAPTIVE_MIN_AVAILABLE_BYTES,
}) {
  if (running < floor) return true;
  if (running >= max || idleCpus === null || idleCpus === undefined) return false;
  if (cpuPressure !== null && cpuPressure >= maxCpuPressure) return false;
  if (availableBytes !== null && availableBytes < minAvailableBytes) return false;
  return msSinceLastStart >= settleMs && idleCpus >= minIdleCpus;
}

export function captureOpenFileDescriptors() {
  if (process.platform === "win32") return { supported: false, descriptors: [] };
  const directory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  try {
    const descriptors = readdirSync(directory)
      .map((value) => Number(value))
      .filter(Number.isSafeInteger)
      .sort((left, right) => left - right);
    return { supported: true, descriptors };
  } catch (error) {
    return { supported: false, descriptors: [], error: error.message };
  }
}

export function shouldRunHubBatchProcessCleanup(platform = process.platform) {
  return platform === "linux";
}

export function fileDescriptorDelta(before, after) {
  if (!before.supported || !after.supported) return undefined;
  const baseline = new Set(before.descriptors);
  return after.descriptors.filter((descriptor) => !baseline.has(descriptor));
}

export function listPosixDescendantProcesses({
  platform = process.platform,
  parentPid = process.pid,
  run = spawnSync,
} = {}) {
  if (platform === "win32") return [];
  const result = inspectPosixResource(run, "/bin/ps", ["-axo", "pid=,ppid=,comm="], "Unable to inspect Hub test descendants");
  const rows = String(result.stdout || "")
    .trim()
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
  const descendants = [];
  const ancestors = new Set([parentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ancestors.has(row.pid) || !ancestors.has(row.ppid)) continue;
      ancestors.add(row.pid);
      descendants.push(row);
      changed = true;
    }
  }
  // The inspection process necessarily observes itself as a direct child.
  return descendants.filter((row) => !/(?:^|\/)ps$/.test(row.command));
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return "unlimited";
  if (value >= GIB) return `${(value / GIB).toFixed(1)} GiB`;
  return `${Math.ceil(value / MIB)} MiB`;
}

export function formatLimit(value) {
  if (value === undefined || value === null) return "n/a";
  return Number.isFinite(value) ? String(value) : "unlimited";
}

export class HubWorkerResourceAudit {
  #active = new Map();
  #nextId = 1;

  track(worker, {
    entrypoint = "src/index.ts",
    address = worker?.address,
    port = worker?.port,
    creationStack,
  } = {}) {
    if (!worker || typeof worker.stop !== "function") {
      throw new TypeError("A tracked Hub worker must expose stop()");
    }
    const record = {
      id: this.#nextId++,
      entrypoint,
      address,
      port,
      createdAt: Date.now(),
      creationStack,
      stopFailures: [],
    };
    this.#active.set(worker, record);
    const originalStop = worker.stop.bind(worker);
    let stopping;
    Object.defineProperty(worker, "stop", {
      configurable: true,
      value: (...args) => {
        if (!stopping) {
          stopping = Promise.resolve()
            .then(() => originalStop(...args))
            .then((result) => {
              this.#active.delete(worker);
              return result;
            })
            .catch((error) => {
              record.stopFailures.push(error?.message || String(error));
              stopping = undefined;
              throw error;
            });
        }
        return stopping;
      },
    });
    return worker;
  }

  activeRecords() {
    return [...this.#active.values()].map((record) => ({ ...record }));
  }

  async cleanupLeaks({ timeoutMs = 15_000 } = {}) {
    const leaked = [...this.#active.entries()];
    const cleanup = await Promise.allSettled(leaked.map(async ([worker]) => {
      let timer;
      try {
        await Promise.race([
          worker.stop(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out stopping leaked Hub worker after ${timeoutMs}ms`)),
              timeoutMs
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }));
    return {
      leaked: leaked.map(([, record]) => ({ ...record })),
      cleanupFailures: cleanup.flatMap((result, index) => result.status === "rejected"
        ? [{ id: leaked[index][1].id, error: result.reason?.message || String(result.reason) }]
        : []),
    };
  }
}

function inspectPosixResource(run, command, args, errorLabel) {
  const result = run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || "").trim() || "unknown error";
    throw new Error(`${errorLabel}: ${detail}`);
  }
  return result;
}
