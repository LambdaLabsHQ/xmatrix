#!/usr/bin/env node
import { positiveIntegerFlag as sharedPositiveIntegerFlag } from "../../../scripts/test-telemetry/cli-flags.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  captureOpenFileDescriptors,
  readHostPressure,
  fileDescriptorDelta,
  formatBytes,
  formatLimit,
  planHubTestResources,
  readPosixFileDescriptorLimits,
  shouldRunHubBatchProcessCleanup,
} from "./hub-test-resources.mjs";
import { runAdaptivePool } from "./hub-test-pool.mjs";
import { HUB_TEST_SLOT_DIRECTORY, describeHubSlots, hubSlotsSupported, tryAcquireHubSlot } from "./hub-test-slots.mjs";
import {
  HUB_SUITE_DEFAULT_EXCLUDES,
  hubSuiteIncludesCampaign,
  listHubSuiteFiles,
} from "./hub-suite-inventory.mjs";
import {
  createNodeSuiteTelemetry,
  parseShard,
  readTimingHistory,
  shardFilesByHistory,
} from "../../../scripts/test-telemetry/node-suite.mjs";
import { dedicatedMachine } from "../../../scripts/ci-machine.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const hubDir = path.resolve(testDir, "..");
const repositoryDir = path.resolve(hubDir, "../..");
const scriptPath = fileURLToPath(import.meta.url);
const FD_BOOTSTRAP_ENV = "XMATRIX_HUB_TEST_FD_BOOTSTRAPPED";
const FD_LEAK_TOLERANCE = 1;

const positiveIntegerFlag = (name, fallback) => sharedPositiveIntegerFlag(name, { fallback });

function concurrencyFlag() {
  const prefix = "--test-concurrency=";
  const raw = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  const configured = process.env.XMATRIX_HUB_TEST_CONCURRENCY;
  if ((!raw || raw.slice(prefix.length) === "auto") && configured) {
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("XMATRIX_HUB_TEST_CONCURRENCY must be a positive integer");
    }
    return parsed;
  }
  if (!raw) return "auto";
  const value = raw.slice(prefix.length);
  if (value === "auto") return value;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("--test-concurrency must be 'auto' or a positive integer");
  }
  return parsed;
}

function reexecWithFileDescriptorLimit(target, currentLimits) {
  if (process.platform === "win32" || currentLimits.soft >= target) return false;
  if (process.env[FD_BOOTSTRAP_ENV] === "1") {
    throw new Error(
      `Hub test file-descriptor bootstrap did not take effect: soft=${currentLimits.soft}, required=${target}`
    );
  }
  console.log(
    `[hub-tests] raising POSIX soft file-descriptor limit ${currentLimits.soft} -> ${target} `
    + `(hard=${formatLimit(currentLimits.hard)})`
  );
  const result = spawnSync("/bin/sh", [
    "-c",
    "ulimit -S -n \"$1\" && shift && exec \"$@\"",
    "xmatrix-hub-test-fd-bootstrap",
    String(target),
    process.execPath,
    ...process.execArgv,
    scriptPath,
    ...process.argv.slice(2),
  ], {
    cwd: hubDir,
    env: { ...process.env, [FD_BOOTSTRAP_ENV]: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function assertNoDescriptorLeak(label, before, after) {
  const opened = fileDescriptorDelta(before, after);
  if (!opened) {
    console.log(`[hub-tests] ${label}: file-descriptor telemetry unavailable`);
    return;
  }
  const delta = after.descriptors.length - before.descriptors.length;
  console.log(
    `[hub-tests] ${label}: fd before=${before.descriptors.length} after=${after.descriptors.length} `
    + `delta=${delta}`
  );
  if (delta > FD_LEAK_TOLERANCE) {
    throw new Error(
      `${label} leaked ${delta} file descriptors (new descriptors: ${opened.join(", ") || "unknown"})`
    );
  }
}

function sourceRevision() {
  if (/^[0-9a-f]{40}$/u.test(process.env.GITHUB_SHA ?? "")) return process.env.GITHUB_SHA;
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryDir, encoding: "utf8" });
  const revision = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/u.test(revision) ? revision : null;
}

function reportResourcePlan(plan, fdLimits) {
  console.log(
    `[hub-tests] resources: concurrency=${plan.concurrency}..${plan.maxConcurrency} (${plan.constrainedBy}), `
    + `hostSlots=${hostSlotsEnabled ? plan.hostSlots : "off"}, `
    + `cpu=${plan.cpuConcurrency}, halfCpu=${plan.halfCpuConcurrency}, `
    + `memory=${formatBytes(plan.memoryBytes)}, memorySlots=${plan.memoryConcurrency}, `
    + `fdSoft=${formatLimit(fdLimits?.soft)}, fdHard=${formatLimit(fdLimits?.hard)}, `
    + `fdRequired=${plan.requiredFdLimit}`
  );
}

const requestedConcurrency = concurrencyFlag();
const timeoutMs = positiveIntegerFlag("--test-timeout", 300_000);

const initialFdLimits = readPosixFileDescriptorLimits();
// XMATRIX_HUB_TEST_HOST_SLOTS sets how many test files every Hub suite on
// this machine may run together, or "off" to run without host slots.
const hostSlotsSetting = process.env.XMATRIX_HUB_TEST_HOST_SLOTS;
const hostSlotsEnabled = hostSlotsSetting !== "off" && hubSlotsSupported();
const resourcePlan = planHubTestResources({
  requestedConcurrency,
  dedicated: dedicatedMachine(),
  fdLimits: initialFdLimits,
  ...(hostSlotsSetting && hostSlotsSetting !== "off" ? { hostSlotSetting: Number(hostSlotsSetting) } : {}),
});
reexecWithFileDescriptorLimit(resourcePlan.requiredFdLimit, initialFdLimits || { soft: Infinity });

const activeFdLimits = readPosixFileDescriptorLimits();
if (activeFdLimits && activeFdLimits.soft < resourcePlan.requiredFdLimit) {
  throw new Error(
    `Hub tests require soft file-descriptor limit ${resourcePlan.requiredFdLimit}, detected ${activeFdLimits.soft}`
  );
}
reportResourcePlan(resourcePlan, activeFdLimits);
if (process.argv.includes("--resource-preflight-only")) process.exit(0);

const suiteFdsBefore = captureOpenFileDescriptors();
const includeCampaign = hubSuiteIncludesCampaign();
const files = listHubSuiteFiles(testDir, { includeCampaign });
// XMATRIX_HUB_TEST_SHARD=<n>/<count> runs one duration-balanced shard, so CI can
// spread the suite over parallel jobs; every shard together is the full suite.
const shard = parseShard(process.env.XMATRIX_HUB_TEST_SHARD);
if (!includeCampaign && HUB_SUITE_DEFAULT_EXCLUDES.length > 0) {
  console.log(
    `[hub-tests] default suite excludes campaign e2e (${HUB_SUITE_DEFAULT_EXCLUDES.join(", ")}); `
    + "set XMATRIX_HUB_TEST_CAMPAIGN=1 or pass --campaign to include",
  );
}
const artifactDirectory = path.join(repositoryDir, "artifacts", "test-telemetry");
const generatedHistoryFile = path.join(artifactDirectory, "hub-timing-history.json");
const historyFile = existsSync(generatedHistoryFile)
  ? generatedHistoryFile
  : path.join(testDir, "timing-history.json");
const allSuiteFiles = files.map((file) => path.posix.join("test", file));
const suiteFiles = shard
  ? shardFilesByHistory(allSuiteFiles, readTimingHistory(historyFile, "hub"), shard)
  : allSuiteFiles;
if (shard) {
  console.log(`[hub-tests] shard ${shard.index + 1}/${shard.count}: ${suiteFiles.length} of ${allSuiteFiles.length} files`);
}
const telemetry = createNodeSuiteTelemetry({
  suite: "hub",
  rootDirectory: hubDir,
  allFiles: suiteFiles,
  concurrency: resourcePlan.concurrency,
  timeoutMs,
  historyFile,
  artifactFile: path.join(artifactDirectory, "hub-run.json"),
  historyOutputFile: generatedHistoryFile,
  sourceRevision: sourceRevision(),
  // Tests import TypeScript sources with plain static imports, so standard
  // tools (esbuild, tsc) see every dependency; one loader serves one module graph.
  imports: ["tsx", "./test/support/platform-preload.mjs"],
});

function runBatchProcessCleanup(batchEnvironment) {
  // The Actions cleanup inspects Linux /proc. Other platforms rely on the
  // process-tree supervisor and must not pass native paths through Git Bash.
  if (!shouldRunHubBatchProcessCleanup()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = spawn(
      "bash",
      [path.join(repositoryDir, ".github/scripts/cleanup-stale-actions-processes.sh"), "--current-orphans"],
      { cwd: repositoryDir, stdio: "inherit", env: { ...process.env, ...batchEnvironment } },
    );
    cleanup.on("error", reject);
    cleanup.on("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error(`Hub batch process cleanup failed with status ${status}`));
    });
  });
}

// One file per short-lived runner process, so completed Workerd fixtures can
// never accumulate in a long-lived process, and its orphans are reclaimed as
// soon as it ends.
async function runFile(file, batchId, currentWorkers) {
  const batchEnvironment = { XMATRIX_ACTIONS_CLEANUP_BATCH: batchId };
  const startedAt = process.hrtime.bigint();
  const result = await telemetry.runLaneAsync(file, 1, [file], { env: batchEnvironment });
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const outcome = result.error ? "spawn error" : result.status === 0 ? "passed" : `exit ${result.status ?? result.signal}`;
  console.log(`[hub-tests] ${file}: ${outcome} in ${seconds.toFixed(1)}s (workers=${currentWorkers()})`);
  await runBatchProcessCleanup(batchEnvironment);
  return result;
}

function finish(results) {
  const evidence = telemetry.finish();
  console.log(`[hub-tests] telemetry: ${path.relative(repositoryDir, evidence.artifactFile)} sha256=${evidence.artifactSha256}`);
  console.log(`[hub-tests] next timing history: ${path.relative(repositoryDir, evidence.historyFile)} sha256=${evidence.historySha256}`);
  assertNoDescriptorLeak("complete Hub suite", suiteFdsBefore, captureOpenFileDescriptors());
  const spawnFailure = results.find((result) => result?.error);
  if (spawnFailure) throw spawnFailure.error;
  const testFailure = results.find((result) => result && result.status !== 0);
  if (testFailure) process.exit(testFailure.status ?? 1);
}

const scheduledFiles = telemetry.orderFiles(suiteFiles);
console.log(
  `[hub-tests] schedule: longest-first adaptive pool, workers=${resourcePlan.concurrency}..${resourcePlan.maxConcurrency}, `
  + `files=${scheduledFiles.length}`,
);
const slotDirectory = process.env.XMATRIX_HUB_TEST_SLOT_DIR || HUB_TEST_SLOT_DIRECTORY;
const acquireSlot = hostSlotsEnabled
  ? (batchId) => tryAcquireHubSlot({ batchId, count: resourcePlan.hostSlots, directory: slotDirectory })
  : () => ({ release() {} });
// The host CPU-pressure gate keeps a suite from adding files while other jobs
// saturate a shared machine. On a machine of its own the only CPU pressure is
// the suite's own Workerd startups, and gating on it left a 2-CPU pool idle
// 40% of the time. Concurrency, host slots and the memory floor still bound
// the pool.
const hostPressureGated = !resourcePlan.dedicated;
if (!hostPressureGated) console.log("[hub-tests] host CPU-pressure admission gate: off (machine of its own)");
finish(await runAdaptivePool(scheduledFiles, {
  floor: resourcePlan.concurrency,
  max: resourcePlan.maxConcurrency,
  acquireSlot,
  runTask: runFile,
  samplePressure: hostPressureGated
    ? readHostPressure
    : () => ({ ...readHostPressure(), cpuPressure: null }),
  describeSlots: () => (hostSlotsEnabled
    ? describeHubSlots({ count: resourcePlan.hostSlots, directory: slotDirectory })
    : "  host slots are off"),
}));
