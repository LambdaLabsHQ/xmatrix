import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimPortLease,
  leaseHolderAlive,
  leasePort,
  portLeaseDir,
  releasePortLease,
} from "./ci-port-lease.mjs";

function tempLeaseDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-port-lease-"));
}

/** A pid that cannot be running: the reclaim path must not need a real corpse. */
const DEAD_PID = 2 ** 22;

test("a leased port is not handed to a second run on the same host", () => {
  const dir = tempLeaseDir();
  assert.equal(claimPortLease(31_000, dir, process.pid), true);
  assert.equal(claimPortLease(31_000, dir, process.pid + 1), false);
});

test("a lease whose holder died is reclaimed instead of parking the port forever", () => {
  const dir = tempLeaseDir();
  assert.equal(leaseHolderAlive(DEAD_PID), false);
  assert.equal(claimPortLease(31_001, dir, DEAD_PID), true);
  // A cancelled run leaves its lock behind; the next run must be able to take it.
  assert.equal(claimPortLease(31_001, dir, process.pid), true);
});

test("release frees the port for the next run but never another run's lease", () => {
  const dir = tempLeaseDir();
  claimPortLease(31_002, dir, process.pid);
  assert.equal(releasePortLease(31_002, dir, process.pid + 1), false, "not ours to release");
  assert.equal(releasePortLease(31_002, dir, process.pid), true);
  assert.equal(claimPortLease(31_002, dir, process.pid + 1), true);
});

test("concurrent runs preferring one port each get a distinct port", async (t) => {
  const dir = tempLeaseDir();
  const isFree = async () => true;
  // Real live pids, because a lease is only binding while its holder runs:
  // invented pids look dead and would be reclaimed, which is the behaviour the
  // stale-lease test covers.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
    stdio: "ignore",
  });
  t.after(() => holder.kill("SIGKILL"));

  const first = await leasePort({ preferred: 31_010, dir, pid: process.pid, isFree });
  const second = await leasePort({ preferred: 31_010, dir, pid: process.ppid, isFree });
  const third = await leasePort({ preferred: 31_010, dir, pid: holder.pid, isFree });
  assert.equal(first.port, 31_010);
  assert.notEqual(second.port, first.port);
  assert.notEqual(third.port, first.port);
  assert.notEqual(third.port, second.port);
});

test("a port bound by an unrelated process is skipped and its lease handed back", async () => {
  const dir = tempLeaseDir();
  const bound = 31_020;
  const lease = await leasePort({
    preferred: bound,
    dir,
    pid: process.pid,
    isFree: async (port) => port !== bound,
  });
  assert.equal(lease.port, bound + 1);
  // The rejected port must not stay leased, or a probe failure would burn it
  // for every later run on this host.
  assert.equal(fs.existsSync(path.join(dir, `${bound}.lock`)), false);
});

test("an exhausted range fails loudly rather than returning a colliding port", async () => {
  const dir = tempLeaseDir();
  await assert.rejects(
    leasePort({ preferred: 31_030, dir, pid: process.pid, isFree: async () => false, span: 3 }),
    /No free port available in 31030-31033/u,
  );
});

test("the lease directory is machine-wide so separate worktrees see each other", () => {
  assert.equal(portLeaseDir({}), path.join(os.tmpdir(), "xmatrix-ci-port-leases"));
  assert.equal(portLeaseDir({ XMATRIX_CI_PORT_LEASE_DIR: "/tmp/x" }), "/tmp/x");
});
