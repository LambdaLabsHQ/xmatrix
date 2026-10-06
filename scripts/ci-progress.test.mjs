import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  nodeTestConcurrencies,
  nodeTestStages,
  resolvedNodeTestResourceFiles,
} from "./ci-node-tests.mjs";
import { ProgressStageError, runProgressStages } from "./ci-progress.mjs";
import {
  createProcessTreeLifecycle,
  processAncestorPids,
  processExists,
  terminateProcessTreeSync,
} from "./process-tree.mjs";

function nodeStage(label, source) {
  return { label, command: process.execPath, args: ["-e", source], cwd: process.cwd(), env: process.env };
}

test("progress runner inherits stdio and reports stage start and success", async () => {
  const lines = [];
  let spawnOptions;
  const spawnImpl = (_command, _args, options) => {
    spawnOptions = options;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  await runProgressStages(
    [nodeStage("streamed success", "process.exit(0)")],
    {
      prefix: "pre-commit",
      ownerPids: [],
      spawnImpl,
      output: (line) => lines.push(line),
      errorOutput: (line) => lines.push(line),
    },
  );
  assert.equal(spawnOptions.stdio, "inherit");
  assert.equal(spawnOptions.detached, process.platform !== "win32");
  assert.match(lines[0], /^\[pre-commit 1\/1] streamed success$/);
  assert.ok(lines.some((line) => line.includes("OK streamed success")), lines.join("\n"));
  assert.match(lines.at(-1), /^\[pre-commit] PASSED 1 stage in /);
});

test("progress runner reports failed stage, command, exit code, and total time", async () => {
  const lines = [];
  await assert.rejects(
    runProgressStages([nodeStage("expected failure", "process.exit(7)")], {
      prefix: "pre-commit",
      ownerPids: [],
      output: (line) => lines.push(line),
      errorOutput: (line) => lines.push(line),
    }),
    (error) => {
      assert.ok(error instanceof ProgressStageError);
      assert.equal(error.details.stage, "expected failure");
      return true;
    },
  );
  const failure = lines.find((line) => line.includes("FAILED expected failure"));
  assert.match(failure, /command=/);
  assert.match(failure, /exit code=7/);
  assert.match(failure, /total=/);
});

function mockProgressSpawner(children, spawned, basePid) {
  return (command) => {
    const child = new EventEmitter();
    child.pid = basePid + spawned.length;
    children.set(command, child);
    spawned.push(command);
    return child;
  };
}

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("parallel progress lanes overlap while each lane retains stage order", async () => {
  const children = new Map();
  const spawned = [];
  const lines = [];
  const spawnImpl = mockProgressSpawner(children, spawned, 1_000);
  const lifecycle = {
    start() {},
    track() {},
    untrack() {},
    cleanup() {},
    dispose() {},
  };
  const stage = (label, parallelLane) => ({
    label,
    command: label,
    args: [],
    cwd: process.cwd(),
    env: process.env,
    ...(parallelLane
      ? { parallelGroup: "resource-wave", parallelLane }
      : {}),
  });
  const running = runProgressStages(
    [stage("lane-a-1", "a"), stage("lane-a-2", "a"), stage("lane-b-1", "b"), stage("serial")],
    {
      ownerPids: [],
      spawnImpl,
      lifecycle,
      output: (line) => lines.push(line),
      errorOutput: (line) => lines.push(line),
    },
  );

  assert.deepEqual(spawned, ["lane-a-1", "lane-b-1"]);
  children.get("lane-a-1").emit("close", 0, null);
  await flushTasks();
  assert.deepEqual(spawned, ["lane-a-1", "lane-b-1", "lane-a-2"]);
  children.get("lane-b-1").emit("close", 0, null);
  children.get("lane-a-2").emit("close", 0, null);
  await flushTasks();
  assert.equal(spawned.at(-1), "serial");
  children.get("serial").emit("close", 0, null);
  await running;

  assert.ok(lines.includes("[ci 1/4] lane-a-1"));
  assert.ok(lines.includes("[ci 2/4] lane-a-2"));
  assert.ok(lines.includes("[ci 3/4] lane-b-1"));
  assert.match(lines.at(-1), /^\[ci\] PASSED 4 stages in /u);
});

test("a parallel lane failure stops sibling trees and reports the first failed stage", async () => {
  const children = new Map();
  const spawned = [];
  let cleanupCalls = 0;
  const spawnImpl = mockProgressSpawner(children, spawned, 2_000);
  const lifecycle = {
    start() {},
    track() {},
    untrack() {},
    cleanup() {
      cleanupCalls += 1;
    },
    dispose() {},
  };
  const stage = (label, lane) => ({
    label,
    command: label,
    args: [],
    cwd: process.cwd(),
    env: process.env,
    parallelGroup: "failure-wave",
    parallelLane: lane,
  });
  const running = runProgressStages(
    [stage("primary-failure", "a"), stage("must-not-start", "a"), stage("sibling", "b")],
    {
      ownerPids: [],
      spawnImpl,
      lifecycle,
      output() {},
      errorOutput() {},
    },
  );
  assert.deepEqual(spawned, ["primary-failure", "sibling"]);
  children.get("primary-failure").emit("exit", 7, null);
  children.get("primary-failure").emit("close", 7, null);
  await flushTasks();
  children.get("sibling").emit("close", null, "SIGKILL");
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof ProgressStageError);
    assert.equal(error.details.stage, "primary-failure");
    return true;
  });
  assert.equal(spawned.includes("must-not-start"), false);
  assert.ok(cleanupCalls >= 1);
});

test("process lifecycle tracks and cleans every concurrent child", () => {
  const processObject = new EventEmitter();
  const terminated = [];
  const lifecycle = createProcessTreeLifecycle({
    processObject,
    ownerPids: [],
    terminateProcessTreeImpl: (pid) => {
      terminated.push(pid);
      return true;
    },
  });
  const first = { pid: 101 };
  const second = { pid: 202 };
  lifecycle.start();
  lifecycle.track(first);
  lifecycle.track(second);
  lifecycle.cleanup();
  assert.deepEqual(terminated, [101, 202]);
  terminated.length = 0;
  lifecycle.untrack(first);
  lifecycle.cleanup();
  assert.deepEqual(terminated, [202]);
  lifecycle.dispose();
});

test("Node check resource lanes cover every discovered test exactly once", () => {
  const actual = fs.readdirSync(new URL(".", import.meta.url))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `scripts/${name}`)
    .sort();
  const categorized = Object.values(resolvedNodeTestResourceFiles(actual)).flat();
  assert.equal(categorized.length, actual.length);
  assert.equal(new Set(categorized).size, categorized.length);
  assert.deepEqual(categorized.toSorted(), actual);

  assert.deepEqual(nodeTestConcurrencies(10), {
    pureContract: 10,
    childProcess: 4,
  });
  assert.deepEqual(nodeTestConcurrencies(1), {
    pureContract: 1,
    childProcess: 1,
  });
  const stages = nodeTestStages({ allFiles: actual, availableParallelism: 10 });
  assert.deepEqual(stages.map((stage) => stage.parallelLane), ["pure-contract", "child-process"]);
});

function waitForFile(file, timeoutMs = 10_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(timer);
        resolve(fs.readFileSync(file, "utf8").trim());
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${file}`));
      }
    }, 25);
  });
}

function waitForClose(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for pid ${child.pid}`)), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function standaloneNodeEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  // A nested `node -e` process is not a node:test file worker. Inheriting the
  // private parent context can make it exit as a test child under parallel load.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processExists(pid), false, `process ${pid} remained alive`);
}

test("progress runner terminates the active descendant tree when its owner exits", { timeout: 30_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-ci-progress-"));
  const pidFile = path.join(tempDir, "descendant.pid");
  const middlePidFile = path.join(tempDir, "middle.pid");
  const middleSource = [
    'const fs = require("node:fs");',
    'fs.writeFileSync(process.env.XMATRIX_TEST_MIDDLE_PID_FILE, String(process.pid));',
    'setInterval(() => {}, 1000);'].join("\n");
  const ownerSource = [
    'const { spawn } = require("node:child_process");',
    `const middle = spawn(process.execPath, ["-e", ${JSON.stringify(middleSource)}], { detached: true, stdio: "ignore", windowsHide: true });`,
    "middle.unref();",
    'setInterval(() => {}, 1000);'].join("\n");
  const owner = spawn(process.execPath, ["-e", ownerSource], {
    env: standaloneNodeEnvironment({ XMATRIX_TEST_MIDDLE_PID_FILE: middlePidFile }),
    stdio: "ignore",
    windowsHide: true,
  });
  const middlePid = Number(await waitForFile(middlePidFile));
  const descendantSource = [
    'const fs = require("node:fs");',
    'fs.writeFileSync(process.env.XMATRIX_TEST_DESCENDANT_PID_FILE, String(process.pid));',
    'setInterval(() => {}, 1000);'].join("\n");
  const stageSource = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore", windowsHide: true });`,
    'setInterval(() => {}, 1000);'].join("\n");
  const progressModule = pathToFileURL(path.resolve("scripts/ci-progress.mjs")).href;
  const fixtureSource = [
    `import { runProgressStages } from ${JSON.stringify(progressModule)};`,
    `const stageSource = ${JSON.stringify(stageSource)};`,
    "await runProgressStages([{ label: 'owner-death fixture', command: process.execPath, args: ['-e', stageSource], cwd: process.cwd(), env: process.env }], { ownerPid: Number(process.env.XMATRIX_TEST_OWNER_PID), ownerPollIntervalMs: 25 });"].join("\n");
  const fixture = spawn(
    process.execPath,
    ["--input-type=module", "-e", fixtureSource],
    {
      cwd: path.resolve("."),
      env: standaloneNodeEnvironment({
        XMATRIX_TEST_DESCENDANT_PID_FILE: pidFile,
        XMATRIX_TEST_OWNER_PID: String(middlePid),
      }),
      stdio: "ignore",
      windowsHide: true,
    },
  );

  let descendantPid;
  try {
    descendantPid = Number(await waitForFile(pidFile));
    assert.equal(processExists(descendantPid), true);
    owner.kill("SIGKILL");
    assert.equal(processExists(middlePid), true, "direct owner should outlive its parent");
    const result = await waitForClose(fixture);
    assert.equal(result.code, 1);
    await waitForProcessExit(descendantPid);
  } finally {
    if (processExists(owner.pid)) owner.kill("SIGKILL");
    if (processExists(middlePid)) terminateProcessTreeSync(middlePid);
    if (processExists(fixture.pid)) terminateProcessTreeSync(fixture.pid);
    if (Number.isSafeInteger(descendantPid) && processExists(descendantPid)) {
      terminateProcessTreeSync(descendantPid);
    }
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("process ancestor snapshots retain the complete live owner chain", () => {
  const spawnSyncImpl = () => ({
    status: 0,
    stdout: "10 1 10\n20 10 20\n30 20 30\n",
  });
  assert.deepEqual(
    processAncestorPids(30, { platform: "linux", spawnSyncImpl }),
    [30, 20, 10],
  );
});
