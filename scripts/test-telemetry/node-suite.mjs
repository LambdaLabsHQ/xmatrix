import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const resourceProbePath = path.join(moduleDirectory, "node-resource-probe.mjs");
const orderedRunnerPath = path.join(moduleDirectory, "ordered-node-test-runner.mjs");
// Node's ESM loader on Windows requires file:// URLs for absolute --import paths.
const resourceProbeImport = pathToFileURL(resourceProbePath).href;

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readTimingHistory(file, suite) {
  const parsed = readJson(file);
  if (parsed?.schemaVersion !== 1 || parsed?.suite !== suite || !parsed.files || typeof parsed.files !== "object") {
    return { schemaVersion: 1, suite, files: {} };
  }
  const files = {};
  for (const [name, value] of Object.entries(parsed.files)) {
    if (!value || typeof value !== "object" || path.isAbsolute(name) || name.includes("..")) continue;
    const durationMs = finiteNonnegative(value.durationMs);
    if (durationMs === null) continue;
    files[name] = {
      durationMs,
      peakRssBytes: safeInteger(value.peakRssBytes),
      peakFdCount: safeInteger(value.peakFdCount),
      samples: safeInteger(value.samples) ?? 0,
      failures: safeInteger(value.failures) ?? 0,
      timeouts: safeInteger(value.timeouts) ?? 0,
    };
  }
  return { schemaVersion: 1, suite, files };
}

/**
 * Longest first, so the slowest files never start last. A file without a
 * measurement may be the longest of all, so it starts before every measured one.
 */
export function orderFilesByHistory(files, history) {
  const weight = (file) => history.files[file]?.durationMs ?? Number.POSITIVE_INFINITY;
  return [...files].sort((left, right) => {
    const leftWeight = weight(left);
    const rightWeight = weight(right);
    if (rightWeight !== leftWeight) return rightWeight > leftWeight ? 1 : -1;
    const leftRss = history.files[left]?.peakRssBytes ?? 0;
    const rightRss = history.files[right]?.peakRssBytes ?? 0;
    if (rightRss !== leftRss) return rightRss - leftRss;
    return left.localeCompare(right);
  });
}

function percentile(values, fraction, fallback) {
  if (values.length === 0) return fallback;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
}

function positiveHistoryValues(files, history, field, predicate = () => true) {
  return files.flatMap((file) => {
    const entry = history.files[file];
    const value = entry?.[field];
    return predicate(entry) && Number.isFinite(value) && value > 0 ? [value] : [];
  });
}

/** `<n>/<count>` (1-based) to a shard, or null when unset. */
export function parseShard(value) {
  if (value === undefined || value === "") return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`Shard must be <n>/<count> with 1 <= n <= count, got ${JSON.stringify(value)}`);
  }
  return { index: Number(match[1]) - 1, count: Number(match[2]) };
}

/**
 * One shard of a suite, balanced by recorded duration: longest file first onto
 * the currently lightest shard. Every file lands in exactly one shard, and the
 * assignment depends only on the file list and history, so every shard of one
 * revision computes the same partition. Unknown files weigh the median.
 */
export function shardFilesByHistory(files, history, { index, count }) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`Invalid shard ${index + 1}/${count}`);
  }
  const known = files.map((file) => history.files[file]?.durationMs).filter((value) => value > 0);
  const fallback = percentile(known, 0.5, 1_000);
  const loads = Array.from({ length: count }, () => 0);
  const assigned = Array.from({ length: count }, () => []);
  for (const file of orderFilesByHistory(files, history)) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += history.files[file]?.durationMs ?? fallback;
    assigned[lightest].push(file);
  }
  return assigned[index];
}

export function planWeightedWaves(files, history, {
  concurrency,
  maxWaves = 8,
  weightSlotsPerWave = 3,
} = {}) {
  for (const [name, value] of Object.entries({ concurrency, maxWaves, weightSlotsPerWave })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (new Set(files).size !== files.length) {
    throw new Error("Weighted test wave input contains duplicate files");
  }
  if (files.length === 0) {
    return {
      waves: [],
      knownFiles: 0,
      unknownFiles: 0,
      censoredFiles: 0,
      fallbackDurationMs: 1,
    };
  }

  const completedDurations = positiveHistoryValues(
    files,
    history,
    "durationMs",
    (entry) => (entry?.timeouts ?? 0) === 0
  );
  const fallbackDurationMs = percentile(completedDurations, 0.5, 1_000);
  // A timeout is right-censored wall time, not an estimate of isolated work.
  // Cap it at a robust completed-suite percentile so one overloaded run cannot
  // permanently dominate every later partition.
  const timeoutDurationMs = percentile(completedDurations, 0.9, fallbackDurationMs);
  const fallbackRssBytes = percentile(
    positiveHistoryValues(files, history, "peakRssBytes"),
    0.5,
    1
  );
  const fallbackFdCount = percentile(
    positiveHistoryValues(files, history, "peakFdCount"),
    0.5,
    1
  );
  let knownFiles = 0;
  let censoredFiles = 0;
  const estimates = files.map((file) => {
    const entry = history.files[file];
    if (entry) knownFiles += 1;
    const timedOut = (entry?.timeouts ?? 0) > 0;
    if (timedOut) censoredFiles += 1;
    const observedDuration = Number.isFinite(entry?.durationMs) && entry.durationMs > 0
      ? entry.durationMs
      : fallbackDurationMs;
    const durationMs = timedOut
      ? Math.max(fallbackDurationMs, Math.min(observedDuration, timeoutDurationMs))
      : observedDuration;
    const rssBytes = Number.isFinite(entry?.peakRssBytes) && entry.peakRssBytes > 0
      ? entry.peakRssBytes
      : fallbackRssBytes;
    const fdCount = Number.isFinite(entry?.peakFdCount) && entry.peakFdCount > 0
      ? entry.peakFdCount
      : fallbackFdCount;
    const rssUnits = Math.min(8, rssBytes / fallbackRssBytes);
    const fdUnits = Math.min(8, fdCount / fallbackFdCount);
    const estimatedWeightMs = Math.max(1, Math.round(
      durationMs + fallbackDurationMs * (rssUnits * 0.25 + fdUnits * 0.1)
    ));
    return { file, durationMs, rssBytes, fdCount, estimatedWeightMs };
  }).sort((left, right) => (
    right.estimatedWeightMs - left.estimatedWeightMs
    || right.durationMs - left.durationMs
    || right.rssBytes - left.rssBytes
    || right.fdCount - left.fdCount
    || left.file.localeCompare(right.file)
  ));

  // A barrier per test batch would trade contention for excessive tail time.
  // Instead, add only enough waves to spread the files most likely to start
  // together across small resource cohorts. Lower auto-concurrency therefore
  // naturally collapses back to fewer (often one) ordinary parallel waves.
  const waveCount = Math.max(1, Math.min(
    maxWaves,
    files.length,
    Math.ceil(Math.min(concurrency, files.length) / weightSlotsPerWave)
  ));
  const maximumFilesPerWave = Math.ceil(files.length / waveCount);
  const bins = Array.from({ length: waveCount }, (_, index) => ({
    index,
    estimatedWeightMs: 0,
    estimates: [],
  }));
  for (const estimate of estimates) {
    const bin = bins
      .filter((candidate) => candidate.estimates.length < maximumFilesPerWave)
      .reduce((best, candidate) => (
        candidate.estimatedWeightMs < best.estimatedWeightMs
        || (candidate.estimatedWeightMs === best.estimatedWeightMs
          && candidate.estimates.length < best.estimates.length)
        || (candidate.estimatedWeightMs === best.estimatedWeightMs
          && candidate.estimates.length === best.estimates.length
          && candidate.index < best.index)
          ? candidate
          : best
      ));
    bin.estimates.push(estimate);
    bin.estimatedWeightMs += estimate.estimatedWeightMs;
  }

  const waves = bins
    .sort((left, right) => right.estimatedWeightMs - left.estimatedWeightMs || left.index - right.index)
    .map((bin) => ({
      files: bin.estimates.map((estimate) => estimate.file),
      estimatedWeightMs: bin.estimatedWeightMs,
    }));
  return {
    waves,
    knownFiles,
    unknownFiles: files.length - knownFiles,
    censoredFiles,
    fallbackDurationMs,
  };
}

function parseEventRecords(file) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of source.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") records.push(parsed);
    } catch {
      // An incomplete reporter line is represented as missing telemetry, never test output.
    }
  }
  return records;
}

function resourceRecords(directory) {
  const records = [];
  try {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue;
      const record = readJson(path.join(directory, entry));
      if (record?.schemaVersion === 1 && typeof record.file === "string") records.push(record);
    }
  } catch {
    // The platform or a hard process termination may leave no resource samples.
  }
  return records;
}

function aggregateLane(lane) {
  const files = new Map(lane.files.map((file, order) => [file, {
    file,
    lane: lane.label,
    scheduledOrder: order,
    status: "incomplete",
    durationMs: null,
    assertionCounts: null,
    failureEvents: 0,
    timedOut: false,
    resourceScope: null,
    peakRssBytes: null,
    peakFdCount: null,
    peakProcessCount: null,
    resourceSamples: 0,
    userCpuMicros: null,
    systemCpuMicros: null,
  }]));

  function matchingFile(file) {
    const exact = files.get(file);
    if (exact) return exact;
    const matches = [...files.values()].filter((candidate) => path.basename(candidate.file) === path.basename(file));
    return matches.length === 1 ? matches[0] : null;
  }

  for (const record of parseEventRecords(lane.eventsFile)) {
    const current = matchingFile(record.file);
    if (!current) continue;
    if (record.kind === "file_complete") {
      current.durationMs = finiteNonnegative(record.durationMs);
      current.status = record.passed === true ? "passed" : "failed";
    } else if (record.kind === "file_summary") {
      current.assertionCounts = record.counts;
    } else if (record.kind === "failure") {
      current.failureEvents += 1;
      current.timedOut ||= record.timeout === true;
    }
  }

  for (const record of resourceRecords(lane.resourcesDirectory)) {
    const current = matchingFile(record.file);
    if (!current) continue;
    current.resourceScope = current.resourceScope === "process_tree" || record.scope === "process_tree"
      ? "process_tree"
      : "node_test_worker";
    current.peakRssBytes = Math.max(current.peakRssBytes ?? 0, safeInteger(record.peakRssBytes) ?? 0);
    if (record.peakFdCount !== null) {
      current.peakFdCount = Math.max(current.peakFdCount ?? 0, safeInteger(record.peakFdCount) ?? 0);
    }
    current.peakProcessCount = Math.max(current.peakProcessCount ?? 0, safeInteger(record.peakProcessCount) ?? 0);
    current.resourceSamples += safeInteger(record.samples) ?? 0;
    current.userCpuMicros = (current.userCpuMicros ?? 0) + (safeInteger(record.userCpuMicros) ?? 0);
    current.systemCpuMicros = (current.systemCpuMicros ?? 0) + (safeInteger(record.systemCpuMicros) ?? 0);
  }

  for (const current of files.values()) {
    if (current.timedOut) current.status = "timeout";
  }
  return [...files.values()];
}

function ewma(previous, current) {
  if (previous === null) return current;
  return Math.round(previous * 0.7 + current * 0.3);
}

export function updateTimingHistory(history, fileResults, sourceRevision, generatedAt) {
  const files = { ...history.files };
  for (const result of fileResults) {
    if (!["passed", "failed", "timeout"].includes(result.status)) continue;
    const previous = files[result.file];
    // Failed and timed-out wall time is censored by the failure mode. Preserve
    // a known-good estimate instead of teaching the next run that contention
    // or early termination is normal work. A new file becomes schedulable from
    // the suite fallback until it completes successfully once.
    if (!previous && (result.status !== "passed" || result.durationMs === null)) continue;
    const baseline = previous ?? {
      durationMs: null,
      peakRssBytes: null,
      peakFdCount: null,
      samples: 0,
      failures: 0,
      timeouts: 0,
    };
    files[result.file] = {
      durationMs: result.status === "passed" && result.durationMs !== null
        ? ewma(baseline.durationMs, Math.round(result.durationMs))
        : baseline.durationMs,
      peakRssBytes: result.peakRssBytes === null
        ? baseline.peakRssBytes
        : ewma(baseline.peakRssBytes, result.peakRssBytes),
      peakFdCount: result.peakFdCount === null
        ? baseline.peakFdCount
        : ewma(baseline.peakFdCount, result.peakFdCount),
      samples: baseline.samples + 1,
      failures: baseline.failures + (result.status === "failed" ? 1 : 0),
      timeouts: baseline.timeouts + (result.status === "timeout" ? 1 : 0),
    };
  }
  return {
    schemaVersion: 1,
    suite: history.suite,
    generatedAt,
    sourceRevision,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function writePrivateJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(file, bytes, { mode: 0o600 });
  chmodSync(file, 0o600);
  return createHash("sha256").update(bytes).digest("hex");
}

export function createNodeSuiteTelemetry({
  suite,
  rootDirectory,
  allFiles,
  concurrency,
  timeoutMs,
  historyFile,
  artifactFile,
  historyOutputFile,
  sourceRevision = null,
  sampleIntervalMs = 1_000,
  // Extra --import modules for every test process (for example a TypeScript
  // loader so tests can import sources statically).
  imports = [],
}) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), `xmatrix-${suite}-telemetry-`));
  chmodSync(temporaryDirectory, 0o700);
  const history = readTimingHistory(historyFile, suite);
  const lanes = [];
  let schedulingPlan = null;

  function orderFiles(files) {
    return orderFilesByHistory(files, history);
  }

  function planWaves(files, options) {
    schedulingPlan = planWeightedWaves(files, history, { concurrency, ...options });
    return schedulingPlan;
  }

  function prepareLane(label, laneConcurrency, files, options) {
    const laneIndex = lanes.length;
    const eventsFile = path.join(temporaryDirectory, `lane-${laneIndex}.ndjson`);
    const resourcesDirectory = path.join(temporaryDirectory, `lane-${laneIndex}-resources`);
    mkdirSync(resourcesDirectory, { mode: 0o700 });
    const lane = { label, concurrency: laneConcurrency, files: [...files], eventsFile, resourcesDirectory };
    lanes.push(lane);
    const childEnvironment = { ...process.env, ...options.env };
    // A focused runner test may itself execute under node:test. The child is a
    // new top-level test run and must receive its own NODE_TEST_CONTEXT.
    delete childEnvironment.NODE_TEST_CONTEXT;
    const args = [
      orderedRunnerPath,
      ...[...imports, resourceProbeImport].map((specifier) => `--test-import=${specifier}`),
      `--test-concurrency=${laneConcurrency}`,
      `--test-timeout=${timeoutMs}`,
      `--events-file=${eventsFile}`,
      "--",
      ...files,
    ];
    const spawnOptions = {
      cwd: rootDirectory,
      env: {
        ...childEnvironment,
        XMATRIX_TEST_TELEMETRY_ROOT: rootDirectory,
        XMATRIX_TEST_TELEMETRY_RESOURCE_DIR: resourcesDirectory,
        XMATRIX_TEST_TELEMETRY_SAMPLE_MS: String(sampleIntervalMs),
      },
    };
    return { lane, args, spawnOptions };
  }

  function runLane(label, laneConcurrency, files, options = {}) {
    const { lane, args, spawnOptions } = prepareLane(label, laneConcurrency, files, options);
    const result = spawnSync(process.execPath, args, { ...spawnOptions, stdio: "inherit" });
    lane.exitStatus = result.status;
    lane.spawnError = Boolean(result.error);
    return result;
  }

  // Runs one lane without blocking, so a caller can keep several lanes in
  // flight. The lane's report is buffered and written in one piece when the
  // lane ends, so concurrent lanes never interleave their output.
  function runLaneAsync(label, laneConcurrency, files, options = {}) {
    const { lane, args, spawnOptions } = prepareLane(label, laneConcurrency, files, options);
    return new Promise((resolve) => {
      const output = [];
      const child = spawn(process.execPath, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => output.push(chunk));
      let spawnError = null;
      child.on("error", (error) => { spawnError = error; });
      child.on("close", (status, signal) => {
        process.stdout.write(Buffer.concat(output));
        lane.exitStatus = status;
        lane.spawnError = Boolean(spawnError);
        resolve({ status, signal, error: spawnError ?? undefined });
      });
    });
  }

  function finish() {
    const completedAt = new Date().toISOString();
    const fileResults = lanes.flatMap(aggregateLane);
    const observed = new Set(fileResults.map((result) => result.file));
    for (const file of allFiles) {
      if (!observed.has(file)) {
        fileResults.push({
          file,
          lane: null,
          scheduledOrder: null,
          status: "not_run",
          durationMs: null,
          assertionCounts: null,
          failureEvents: 0,
          timedOut: false,
          resourceScope: null,
          peakRssBytes: null,
          peakFdCount: null,
          peakProcessCount: null,
          resourceSamples: 0,
          userCpuMicros: null,
          systemCpuMicros: null,
        });
      }
    }
    const counts = { passed: 0, failed: 0, timeout: 0, incomplete: 0, notRun: 0 };
    for (const result of fileResults) {
      if (result.status === "passed") counts.passed += 1;
      else if (result.status === "failed") counts.failed += 1;
      else if (result.status === "timeout") counts.timeout += 1;
      else if (result.status === "not_run") counts.notRun += 1;
      else counts.incomplete += 1;
    }
    const artifact = {
      schemaVersion: 1,
      artifactType: "xmatrix_node_test_telemetry",
      suite,
      sourceRevision,
      startedAt,
      completedAt,
      durationMs: Number(process.hrtime.bigint() - startedNs) / 1_000_000,
      runtime: {
        nodeVersion: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
      },
      policy: {
        concurrency,
        timeoutMs,
        ordering: schedulingPlan ? "historical_weighted_waves" : "historical_duration_descending",
        waves: schedulingPlan?.waves.length ?? 1,
        historicalFiles: schedulingPlan?.knownFiles ?? null,
        unknownFiles: schedulingPlan?.unknownFiles ?? null,
        censoredFiles: schedulingPlan?.censoredFiles ?? null,
        waveEstimatedWeightsMs: schedulingPlan?.waves.map((wave) => wave.estimatedWeightMs) ?? null,
        resourceSampleIntervalMs: sampleIntervalMs,
        resourceScope: process.platform === "linux" ? "process_tree" : "node_test_worker",
        descendantResourcesAvailable: process.platform === "linux",
      },
      lanes: lanes.map((lane) => ({
        label: lane.label,
        concurrency: lane.concurrency,
        files: lane.files.length,
        exitStatus: lane.exitStatus,
        spawnError: lane.spawnError,
      })),
      counts,
      files: fileResults.sort((left, right) => left.file.localeCompare(right.file)),
    };
    const nextHistory = updateTimingHistory(history, fileResults, sourceRevision, completedAt);
    const artifactSha256 = writePrivateJson(artifactFile, artifact);
    const historySha256 = writePrivateJson(historyOutputFile, nextHistory);
    rmSync(temporaryDirectory, { recursive: true, force: true });
    return { artifact, artifactFile, artifactSha256, historyFile: historyOutputFile, historySha256 };
  }

  return { orderFiles, planWaves, runLane, runLaneAsync, finish };
}
