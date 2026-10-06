import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  HUB_TEST_BATCH_ENV,
  batchProcesses,
  describeHubSlots,
  hubSlotsSupported,
  tryAcquireHubSlot,
} from "./hub-test-slots.mjs";

const skip = !hubSlotsSupported() && "host slots need Linux /proc and flock";
const moduleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "hub-test-slots.mjs")).href;
const temporary = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("host slots admit at most their count and free a slot on release", { skip }, () => {
  const directory = temporary("xmatrix-hub-slots-");
  const first = tryAcquireHubSlot({ batchId: "batch-a", count: 2, directory });
  const second = tryAcquireHubSlot({ batchId: "batch-b", count: 2, directory });
  assert.ok(first && second);
  assert.notEqual(first.index, second.index);
  assert.equal(tryAcquireHubSlot({ batchId: "batch-c", count: 2, directory }), null);
  first.release();
  const third = tryAcquireHubSlot({ batchId: "batch-c", count: 2, directory });
  assert.equal(third?.index, first.index, "the released slot is admitted again");
  assert.equal(readFileSync(path.join(directory, `slot-${first.index}.lock`), "utf8"), "batch-c",
    "the slot records its task in place before the task starts");
  second.release();
  third.release();
});

for (const batchEnv of [HUB_TEST_BATCH_ENV, "XMATRIX_CI_HOST_BATCH"]) {
test(`a killed slot holder cannot admit over surviving ${batchEnv} children`, { skip }, async () => {
  const scan = (batchId) => batchProcesses(batchId, { batchEnv });
  const directory = temporary("xmatrix-hub-slots-");
  const holderScript = path.join(directory, "holder.mjs");
  writeFileSync(holderScript, [
    `import { spawn } from "node:child_process";`,
    `import { tryAcquireHubSlot } from ${JSON.stringify(moduleUrl)};`,
    `const slot = tryAcquireHubSlot({ batchId: "killed-task", count: 1, directory: ${JSON.stringify(directory)} });`,
    `if (!slot) process.exit(3);`,
    `const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {`,
    `  detached: true, stdio: "ignore", env: { ...process.env, ${batchEnv}: "killed-task" },`,
    `});`,
    `descendant.unref();`,
    `console.log(descendant.pid);`,
    `setInterval(() => {}, 1000);`,
  ].join("\n"));
  const holder = spawn(process.execPath, [holderScript], { stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(holder.stdout, "data");
  const descendant = Number(String(line).trim());
  try {
    assert.equal(tryAcquireHubSlot({ batchId: "next-task", count: 1, directory, scan }), null, "the holder still has the lock");

    holder.kill("SIGKILL");
    await once(holder, "exit");
    assert.ok(alive(descendant), "the killed holder's task still has a live descendant");
    assert.deepEqual(scan("killed-task"), [descendant]);
    assert.equal(tryAcquireHubSlot({ batchId: "next-task", count: 1, directory, scan }), null,
      "the lock is free, but the previous task's residue keeps the slot closed");

    process.kill(descendant, "SIGKILL");
    await waitUntil(() => scan("killed-task")?.length === 0);
    const admitted = tryAcquireHubSlot({ batchId: "next-task", count: 1, directory, scan });
    assert.ok(admitted, "the slot opens once the old task has fully exited");
    admitted.release();
  } finally {
    if (alive(descendant)) process.kill(descendant, "SIGKILL");
    if (holder.exitCode === null) holder.kill("SIGKILL");
  }
});
}

test("an unreadable process table refuses admission instead of assuming nobody is left", { skip }, () => {
  const directory = temporary("xmatrix-hub-slots-");
  tryAcquireHubSlot({ batchId: "earlier-task", count: 1, directory }).release();
  assert.equal(batchProcesses("earlier-task", { procDirectory: path.join(directory, "missing-proc") }), null);
  assert.equal(tryAcquireHubSlot({ batchId: "next-task", count: 1, directory, scan: () => null }), null);
  const admitted = tryAcquireHubSlot({ batchId: "next-task", count: 1, directory });
  assert.ok(admitted);
  admitted.release();
});

test("slot batch ids are confined to a safe token", () => {
  assert.throws(() => tryAcquireHubSlot({ batchId: "../escape", count: 1, directory: temporary("xmatrix-hub-slots-") }),
    /Invalid Hub task batch id/u);
});

test("a slot description names each slot's batch, lock state and residue", { skip }, () => {
  const directory = temporary("xmatrix-hub-slots-");
  const held = tryAcquireHubSlot({ batchId: "held-task", count: 1, directory });
  assert.match(describeHubSlots({ count: 2, directory }),
    /slot-0: locked, batch=held-task, residue pids=none\n {2}slot-1: missing, batch=-, residue pids=none/u);
  held.release();
  assert.match(describeHubSlots({ count: 1, directory }), /slot-0: free, batch=held-task/u);
});
