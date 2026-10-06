import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  createNodeSuiteTelemetry,
  orderFilesByHistory,
  planWeightedWaves,
  readTimingHistory,
  updateTimingHistory,
} from "./test-telemetry/node-suite.mjs";
import { sanitizeNodeTestEvent } from "./test-telemetry/node-test-reporter.mjs";
import { sampleLinuxProcessTree } from "./test-telemetry/resources.mjs";

// These contracts measure process isolation and telemetry, not startup latency.
// File timeouts include worker startup and exit sampling on shared CI runners.
const fixtureTimeoutMs = 60_000;

function telemetryFixturePaths(root, outputDirectory) {
  return {
    timeoutMs: fixtureTimeoutMs,
    historyFile: path.join(root, "missing-history.json"),
    artifactFile: path.join(outputDirectory, "run.json"),
    historyOutputFile: path.join(outputDirectory, "history.json"),
  };
}

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  chmodSync(directory, 0o700);
  return directory;
}

test("reporter emits only normalized scheduling facts", () => {
  const root = temporaryDirectory("xmatrix-reporter-");
  const file = path.join(root, "test", "safe.test.mjs");
  const complete = sanitizeNodeTestEvent({
    type: "test:complete",
    data: {
      name: "test/safe.test.mjs",
      file,
      details: { duration_ms: 12.5, passed: false },
    },
  }, root);
  const failure = sanitizeNodeTestEvent({
    type: "test:fail",
    data: {
      file,
      details: {
        error: {
          failureType: "testTimeoutFailure",
          message: "Bearer must-not-appear",
          stack: "private/local/path",
        },
      },
    },
  }, root);

  assert.deepEqual(complete, {
    kind: "file_complete",
    file: "test/safe.test.mjs",
    durationMs: 12.5,
    passed: false,
  });
  assert.deepEqual(failure, {
    kind: "failure",
    file: "test/safe.test.mjs",
    timeout: true,
  });
  assert.doesNotMatch(JSON.stringify([complete, failure]), /Bearer|must-not-appear|private\/local/u);
});

test("history is validated and schedules longest files first", () => {
  const root = temporaryDirectory("xmatrix-history-");
  const file = path.join(root, "history.json");
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    suite: "hub",
    files: {
      "test/short.test.mjs": { durationMs: 10, peakRssBytes: 50, samples: 2 },
      "test/long.test.mjs": { durationMs: 500, peakRssBytes: 5, samples: 3 },
      "../outside.test.mjs": { durationMs: 100_000 },
    },
  }));

  const history = readTimingHistory(file, "hub");
  assert.deepEqual(orderFilesByHistory([
    "test/unknown.test.mjs",
    "test/short.test.mjs",
    "test/long.test.mjs",
  ], history), [
    "test/unknown.test.mjs",
    "test/long.test.mjs",
    "test/short.test.mjs",
  ]);
  assert.equal(history.files["../outside.test.mjs"], undefined);

  const updated = updateTimingHistory(history, [{
    file: "test/long.test.mjs",
    durationMs: 1_000,
    peakRssBytes: 100,
    peakFdCount: 20,
    status: "timeout",
  }], "a".repeat(40), "2026-07-19T00:00:00.000Z");
  assert.equal(updated.files["test/long.test.mjs"].durationMs, 500);
  assert.equal(updated.files["test/long.test.mjs"].timeouts, 1);
  const failed = updateTimingHistory(history, [{
    file: "test/long.test.mjs",
    durationMs: 5,
    peakRssBytes: 100,
    peakFdCount: 20,
    status: "failed",
  }], "d".repeat(40), "2026-07-19T00:00:30.000Z");
  assert.equal(failed.files["test/long.test.mjs"].durationMs, 500);
  assert.equal(failed.files["test/long.test.mjs"].failures, 1);
  const recovered = updateTimingHistory(updated, [{
    file: "test/long.test.mjs",
    durationMs: 1_000,
    peakRssBytes: 100,
    peakFdCount: 20,
    status: "passed",
  }], "b".repeat(40), "2026-07-19T00:01:00.000Z");
  assert.equal(recovered.files["test/long.test.mjs"].durationMs, 650);
  const failedNewFile = updateTimingHistory(history, [{
    file: "test/new.test.mjs",
    durationMs: 5,
    peakRssBytes: 100,
    peakFdCount: 20,
    status: "failed",
  }], "c".repeat(40), "2026-07-19T00:02:00.000Z");
  assert.equal(failedNewFile.files["test/new.test.mjs"], undefined);
});

test("weighted waves spread historical work without naming special test files", () => {
  const files = Array.from({ length: 20 }, (_, index) => `test/file-${index}.test.mjs`);
  const history = {
    schemaVersion: 1,
    suite: "fixture",
    files: Object.fromEntries(files.map((file, index) => [file, {
      durationMs: index === 0 ? 30_000 : index === 3 ? 300_000 : 1_000 + index,
      peakRssBytes: index === 1 ? 800_000_000 : index === 3 ? 400_000_000 : 80_000_000,
      peakFdCount: index === 2 ? 800 : index === 3 ? 80 : 8,
      timeouts: index === 3 ? 1 : 0,
    }])),
  };
  const plan = planWeightedWaves(files, history, {
    concurrency: 4,
    maxWaves: 4,
    weightSlotsPerWave: 1,
  });

  assert.equal(plan.waves.length, 4);
  assert.equal(plan.knownFiles, files.length);
  assert.equal(plan.unknownFiles, 0);
  assert.equal(plan.censoredFiles, 1);
  assert.deepEqual(
    plan.waves.flatMap((wave) => wave.files).sort(),
    [...files].sort()
  );
  for (const heavyweight of files.slice(0, 4)) {
    assert.equal(plan.waves.filter((wave) => wave.files.includes(heavyweight)).length, 1);
  }
  assert.equal(new Set(files.slice(0, 4).map((file) => (
    plan.waves.findIndex((wave) => wave.files.includes(file))
  ))).size, 4);
  assert.ok(plan.waves.every((wave) => wave.files.length === 5));

  assert.equal(planWeightedWaves(files, history, {
    concurrency: 10,
    maxWaves: 8,
  }).waves.length, 4);
  assert.equal(planWeightedWaves(files, history, {
    concurrency: 3,
    maxWaves: 8,
  }).waves.length, 1);
});

test("weighted waves use a robust fallback for unknown and timed-out files", () => {
  const history = {
    schemaVersion: 1,
    suite: "fixture",
    files: {
      "test/complete-a.test.mjs": {
        durationMs: 100,
        peakRssBytes: 10,
        peakFdCount: 2,
        timeouts: 0,
      },
      "test/complete-b.test.mjs": {
        durationMs: 200,
        peakRssBytes: 20,
        peakFdCount: 4,
        timeouts: 0,
      },
      "test/timed-out.test.mjs": {
        durationMs: 300_000,
        peakRssBytes: 30,
        peakFdCount: 6,
        timeouts: 1,
      },
    },
  };
  const plan = planWeightedWaves([
    "test/complete-a.test.mjs",
    "test/complete-b.test.mjs",
    "test/timed-out.test.mjs",
    "test/new.test.mjs",
  ], history, { concurrency: 2, maxWaves: 2, weightSlotsPerWave: 1 });

  assert.equal(plan.fallbackDurationMs, 100);
  assert.equal(plan.censoredFiles, 1);
  assert.equal(plan.knownFiles, 3);
  assert.equal(plan.unknownFiles, 1);
  const largestWave = Math.max(...plan.waves.map((wave) => wave.estimatedWeightMs));
  const smallestWave = Math.min(...plan.waves.map((wave) => wave.estimatedWeightMs));
  assert.ok(largestWave < smallestWave * 2, JSON.stringify(plan));
  assert.throws(() => planWeightedWaves([
    "test/duplicate.test.mjs",
    "test/duplicate.test.mjs",
  ], history, { concurrency: 1 }), /duplicate files/);
});

test("Linux sampler accounts for the full descendant process tree", () => {
  const proc = temporaryDirectory("xmatrix-proc-");
  for (const [pid, parentPid, rssKb, fds] of [
    [100, 1, 20, 2],
    [101, 100, 30, 3],
    [102, 101, 40, 4],
    [200, 1, 999, 5],
  ]) {
    const processDirectory = path.join(proc, String(pid));
    mkdirSync(path.join(processDirectory, "fd"), { recursive: true });
    writeFileSync(path.join(processDirectory, "stat"), `${pid} (fixture) S ${parentPid} 0 0 0\n`);
    writeFileSync(path.join(processDirectory, "status"), `Name:\tfixture\nVmRSS:\t${rssKb} kB\n`);
    for (let descriptor = 0; descriptor < fds; descriptor += 1) {
      writeFileSync(path.join(processDirectory, "fd", String(descriptor)), "");
    }
  }

  assert.deepEqual(sampleLinuxProcessTree(100, proc), {
    scope: "process_tree",
    rssBytes: 90 * 1024,
    fdCount: 9,
    processCount: 3,
  });
});

test("ordered Node lanes execute files in the requested order", () => {
  const parentBatch = process.env.XMATRIX_ACTIONS_CLEANUP_BATCH;
  const root = temporaryDirectory("xmatrix-ordered-suite-");
  const testDirectory = path.join(root, "test");
  const outputDirectory = path.join(root, "artifacts");
  const markerFile = path.join(root, "started.txt");
  mkdirSync(testDirectory);
  for (const [file, marker] of [
    ["a-second.test.mjs", "a"],
    ["z-first.test.mjs", "z"],
  ]) {
    writeFileSync(path.join(testDirectory, file), [
      'import { appendFileSync } from "node:fs";',
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      `appendFileSync(${JSON.stringify(markerFile)}, ${JSON.stringify(`${marker}\n`)});`,
      `test(${JSON.stringify(marker)}, () => { assert.equal(process.env.XMATRIX_ACTIONS_CLEANUP_BATCH, "isolated-lane"); });`,
      "",
    ].join("\n"));
  }

  const telemetry = createNodeSuiteTelemetry({
    suite: "ordered-fixture",
    rootDirectory: root,
    allFiles: ["test/a-second.test.mjs", "test/z-first.test.mjs"],
    concurrency: 1,
    ...telemetryFixturePaths(root, outputDirectory),
  });
  const result = telemetry.runLane("ordered", 1, [
    "test/z-first.test.mjs",
    "test/a-second.test.mjs",
  ], { env: { XMATRIX_ACTIONS_CLEANUP_BATCH: "isolated-lane" } });
  assert.equal(result.status, 0);
  assert.equal(process.env.XMATRIX_ACTIONS_CLEANUP_BATCH, parentBatch);
  assert.equal(readFileSync(markerFile, "utf8"), "z\na\n");
  assert.deepEqual(
    telemetry.finish().artifact.files.map(({ file, status }) => ({ file, status })),
    [
      { file: "test/a-second.test.mjs", status: "passed" },
      { file: "test/z-first.test.mjs", status: "passed" },
    ],
  );
});

test("test imports run once per isolated worker without loading in the reporter", () => {
  const root = temporaryDirectory("xmatrix-import-suite-");
  const testDirectory = path.join(root, "test");
  const markerFile = path.join(root, "imports.ndjson");
  const preload = path.join(root, "preload.mjs");
  mkdirSync(testDirectory);
  writeFileSync(preload, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ pid: process.pid, context: process.env.NODE_TEST_CONTEXT }) + "\\n");`,
    'globalThis.importFixture = { order: ["first"] };',
  ].join("\n"));
  const secondPreload = path.join(root, "second-preload.mjs");
  writeFileSync(secondPreload, 'globalThis.importFixture.order.push("second");\n');
  const files = ["test/first.test.mjs", "test/second.test.mjs"];
  for (const file of files) {
    writeFileSync(path.join(root, file), [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'test("ordered imports and isolated state", () => {',
      '  assert.deepEqual(globalThis.importFixture.order, ["first", "second"]);',
      '  assert.equal(globalThis.importFixture.touched, undefined);',
      '  globalThis.importFixture.touched = true;',
      '});',
    ].join("\n"));
  }
  const telemetry = createNodeSuiteTelemetry({
    suite: "import-fixture",
    rootDirectory: root,
    allFiles: files,
    concurrency: 1,
    imports: [pathToFileURL(preload).href, pathToFileURL(secondPreload).href],
    ...telemetryFixturePaths(root, path.join(root, "artifacts")),
  });
  assert.equal(telemetry.runLane("imports", 1, files).status, 0);
  const records = readFileSync(markerFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, files.length);
  assert.equal(new Set(records.map(({ pid }) => pid)).size, files.length);
  assert.ok(records.every(({ context }) => context));
  const { artifact } = telemetry.finish();
  assert.deepEqual(artifact.files.map(({ file, status }) => ({ file, status })),
    files.map((file) => ({ file, status: "passed" })));
  assert.ok(artifact.files.every(({ peakRssBytes, resourceSamples }) => peakRssBytes > 0 && resourceSamples >= 2));
});

test("concurrent async lanes overlap, keep their output whole, and report every file", async () => {
  const root = temporaryDirectory("xmatrix-async-suite-");
  const testDirectory = path.join(root, "test");
  const outputDirectory = path.join(root, "artifacts");
  mkdirSync(testDirectory);
  // Each file waits for the other to start, so they pass only when both lanes
  // run at the same time.
  for (const [self, other] of [["left", "right"], ["right", "left"]]) {
    writeFileSync(path.join(testDirectory, `${self}.test.mjs`), [
      'import { existsSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'import { test } from "node:test";',
      `test(${JSON.stringify(`${self} overlaps`)}, async () => {`,
      `  writeFileSync(path.join(${JSON.stringify(root)}, ${JSON.stringify(`${self}.started`)}), "");`,
      `  while (!existsSync(path.join(${JSON.stringify(root)}, ${JSON.stringify(`${other}.started`)}))) {`,
      "    await new Promise((resolve) => setTimeout(resolve, 10));",
      "  }",
      "});",
      "",
    ].join("\n"));
  }
  writeFileSync(path.join(testDirectory, "fail.test.mjs"), [
    'import { test } from "node:test";',
    'test("expected async fixture failure", () => { throw new Error("expected async fixture failure"); });',
    "",
  ].join("\n"));
  const telemetry = createNodeSuiteTelemetry({
    suite: "async-fixture",
    rootDirectory: root,
    allFiles: ["test/fail.test.mjs", "test/left.test.mjs", "test/right.test.mjs"],
    concurrency: 2,
    ...telemetryFixturePaths(root, outputDirectory),
  });
  const results = await Promise.all([
    telemetry.runLaneAsync("left", 1, ["test/left.test.mjs"]),
    telemetry.runLaneAsync("right", 1, ["test/right.test.mjs"]),
  ]);
  assert.deepEqual(results.map((result) => result.status), [0, 0]);
  assert.equal((await telemetry.runLaneAsync("fail", 1, ["test/fail.test.mjs"])).status, 1);
  assert.deepEqual(
    telemetry.finish().artifact.files.map(({ file, lane, status }) => ({ file, lane, status })),
    [
      { file: "test/fail.test.mjs", lane: "fail", status: "failed" },
      { file: "test/left.test.mjs", lane: "left", status: "passed" },
      { file: "test/right.test.mjs", lane: "right", status: "passed" },
    ],
  );
});

test("focused Node waves preserve failure, discovery, and resource telemetry", () => {
  const root = temporaryDirectory("xmatrix-suite-");
  const testDirectory = path.join(root, "test");
  const outputDirectory = path.join(root, "artifacts");
  mkdirSync(testDirectory);
  writeFileSync(path.join(testDirectory, "fast.test.mjs"), [
    'import { test } from "node:test";',
    'test("fast", () => {});',
    "",
  ].join("\n"));
  writeFileSync(path.join(testDirectory, "slow.test.mjs"), [
    'import { test } from "node:test";',
    'test("slow", async () => new Promise((resolve) => setTimeout(resolve, 30)));',
    "",
  ].join("\n"));
  writeFileSync(path.join(testDirectory, "fail.test.mjs"), [
    'import { test } from "node:test";',
    'test("expected fixture failure", () => { throw new Error("expected fixture failure"); });',
    "",
  ].join("\n"));
  const historyFile = path.join(root, "history.json");
  writeFileSync(historyFile, JSON.stringify({
    schemaVersion: 1,
    suite: "fixture",
    files: {
      "test/fail.test.mjs": { durationMs: 200, peakRssBytes: null, peakFdCount: null, samples: 1 },
      "test/slow.test.mjs": { durationMs: 100, peakRssBytes: null, peakFdCount: null, samples: 1 },
      "test/fast.test.mjs": { durationMs: 1, peakRssBytes: null, peakFdCount: null, samples: 1 },
    },
  }));
  const artifactFile = path.join(outputDirectory, "run.json");
  const historyOutputFile = path.join(outputDirectory, "history.json");
  const telemetry = createNodeSuiteTelemetry({
    suite: "fixture",
    rootDirectory: root,
    allFiles: ["test/fail.test.mjs", "test/fast.test.mjs", "test/slow.test.mjs"],
    concurrency: 2,
    timeoutMs: fixtureTimeoutMs,
    historyFile,
    artifactFile,
    historyOutputFile,
    sourceRevision: "b".repeat(40),
    sampleIntervalMs: 250,
  });
  const scheduled = telemetry.orderFiles([
    "test/fast.test.mjs",
    "test/slow.test.mjs",
    "test/fail.test.mjs",
  ]);
  assert.deepEqual(scheduled, ["test/fail.test.mjs", "test/slow.test.mjs", "test/fast.test.mjs"]);
  const plan = telemetry.planWaves(scheduled, { maxWaves: 2, weightSlotsPerWave: 1 });
  assert.equal(plan.waves.length, 2);
  const results = plan.waves.map((wave, index) => telemetry.runLane(
    `focused-${index + 1}`,
    1,
    wave.files
  ));
  assert.deepEqual(results.map((result) => result.status), [1, 0]);
  const evidence = telemetry.finish();
  const artifact = JSON.parse(readFileSync(artifactFile, "utf8"));

  assert.equal(evidence.artifactSha256.length, 64);
  assert.deepEqual(
    artifact.counts,
    { passed: 2, failed: 1, timeout: 0, incomplete: 0, notRun: 0 },
    JSON.stringify(artifact.files, null, 2),
  );
  assert.equal(artifact.policy.ordering, "historical_weighted_waves");
  assert.equal(artifact.policy.waves, 2);
  assert.equal(artifact.policy.waveEstimatedWeightsMs.length, 2);
  assert.equal(artifact.lanes.length, 2);
  for (const file of artifact.files) {
    assert.equal(file.status, file.file === "test/fail.test.mjs" ? "failed" : "passed");
    assert.ok(file.durationMs > 0);
    assert.ok(file.peakRssBytes > 0);
    assert.ok(file.resourceSamples >= 2);
    if (process.platform !== "win32") assert.ok(file.peakFdCount > 0);
  }
  if (process.platform !== "win32") assert.equal(statSync(artifactFile).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(artifactFile, "utf8"), /xmatrix-suite-[^/"]+/u);
  assert.equal(JSON.parse(readFileSync(historyOutputFile, "utf8")).files["test/slow.test.mjs"].samples, 2);
});

test("hub shards partition the suite exactly and balance recorded duration", async () => {
  const { parseShard, shardFilesByHistory } = await import("./test-telemetry/node-suite.mjs");
  const history = { files: { "a": { durationMs: 90 }, "b": { durationMs: 60 }, "c": { durationMs: 50 }, "d": { durationMs: 40 } } };
  const files = ["a", "b", "c", "d", "e"];
  const shards = [0, 1].map((index) => shardFilesByHistory(files, history, { index, count: 2 }));
  assert.deepEqual(shards.flat().sort(), files);
  assert.equal(new Set(shards.flat()).size, files.length);
  // The unmeasured file starts first, weighing the median; then longest-first
  // onto the lightest shard: e+b+d (150) vs a+c (140).
  assert.deepEqual(shards, [["e", "b", "d"], ["a", "c"]]);
  assert.deepEqual(parseShard("2/3"), { index: 1, count: 3 });
  assert.equal(parseShard(undefined), null);
  for (const invalid of ["0/2", "3/2", "1", "a/b", "1/0"]) assert.throws(() => parseShard(invalid), invalid);
});
