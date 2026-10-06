import { spawnSync } from "node:child_process";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Host-wide Hub test slots: cooperative concurrency control shared by every
// Hub suite on one machine (both CI shards, the release gate, a local run).
//
// Each slot is a file that is created once and never replaced or deleted, so
// every runner on the host locks the same inodes. A suite admits one test
// file per slot it holds: it opens the slot, takes a non-blocking flock on
// that open file (the lock belongs to the suite's descriptor, so it vanishes
// when the suite exits for any reason), reads the batch id of the slot's
// previous task, and admits only when no process still carries that batch's
// cleanup tag. It then writes its own batch id in place, before spawning the
// task, and holds the lock until the task has been cleaned up.
//
// The residue check is conservative, not a supervision guarantee: a process
// that forks and exits while /proc is being listed, or a descendant that
// clears its environment, can escape it. Strict lifecycle isolation would
// need cgroups; this only keeps cooperating suites from overcommitting.
export const HUB_TEST_SLOT_DIRECTORY = path.join(os.homedir(), ".cache", "xmatrix", "hub-test-slots");
export const HUB_TEST_BATCH_ENV = "XMATRIX_ACTIONS_CLEANUP_BATCH";
const FLOCK_BUSY = 222;

/**
 * Pids of processes that still carry `batchId` in their cleanup tag, or null
 * when /proc could not be scanned: "could not look" is never "nobody left".
 */
export function batchProcesses(batchId, { procDirectory = "/proc", selfPid = process.pid, batchEnv = HUB_TEST_BATCH_ENV } = {}) {
  let entries;
  try {
    entries = readdirSync(procDirectory);
  } catch {
    return null;
  }
  const tag = `${batchEnv}=${batchId}`;
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry) || Number(entry) === selfPid) continue;
    let environ;
    try {
      environ = readFileSync(path.join(procDirectory, entry, "environ"), "latin1");
    } catch (error) {
      // Exited while listing, or another user's process (never a Hub task).
      if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code)) continue;
      return null;
    }
    if (environ.split("\0").includes(tag)) found.push(Number(entry));
  }
  return found;
}

/** Take a non-blocking flock on an open slot descriptor; false when another suite holds it. */
function lockDescriptor(fd) {
  const result = spawnSync("flock", ["-n", "-E", String(FLOCK_BUSY), "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
  if (result.status === 0) return true;
  if (result.status === FLOCK_BUSY) return false;
  throw new Error(`flock failed on a Hub test slot: ${result.error?.message ?? String(result.stderr ?? "").trim()}`);
}

export function hostSlotsSupported(platform = process.platform) {
  return platform === "linux" && spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Admit one task into a free host slot, or return null when every slot is
 * held or still has residue. The returned release() drops the lock; call it
 * only after the task and its cleanup have finished.
 */
export function tryAcquireHostSlot({
  batchId,
  count,
  directory = HUB_TEST_SLOT_DIRECTORY,
  scan = batchProcesses,
  lock = lockDescriptor,
  random = Math.random,
}) {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(batchId ?? "")) throw new Error(`Invalid Hub task batch id: ${batchId}`);
  mkdirSync(directory, { recursive: true });
  const start = Math.floor(random() * count);
  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % count;
    const file = path.join(directory, `slot-${index}.lock`);
    closeSync(openSync(file, "a"));
    const fd = openSync(file, "r+");
    let admitted = false;
    try {
      if (!lock(fd)) continue;
      const buffer = Buffer.alloc(256);
      const previous = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8").trim();
      if (previous) {
        const residue = scan(previous);
        if (residue === null || residue.length > 0) continue;
      }
      ftruncateSync(fd, 0);
      writeSync(fd, batchId, 0);
      admitted = true;
      return { index, release: () => closeSync(fd) };
    } finally {
      if (!admitted) closeSync(fd);
    }
  }
  return null;
}

/** One line per slot, for a failure message: its last batch, whether it is locked, and live residue. */
export function describeHostSlots({
  count,
  directory = HUB_TEST_SLOT_DIRECTORY,
  scan = batchProcesses,
  lock = lockDescriptor,
}) {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const file = path.join(directory, `slot-${index}.lock`);
    let batch = "";
    let locked = "unknown";
    try {
      batch = readFileSync(file, "utf8").trim();
      const fd = openSync(file, "r");
      try {
        locked = lock(fd) ? "free" : "locked";
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      locked = error?.code === "ENOENT" ? "missing" : `unreadable (${error?.message})`;
    }
    const residue = batch ? scan(batch) : [];
    const pids = residue === null ? "unscannable" : residue.length ? residue.join(",") : "none";
    lines.push(`  slot-${index}: ${locked}, batch=${batch || "-"}, residue pids=${pids}`);
  }
  return lines.join("\n");
}
