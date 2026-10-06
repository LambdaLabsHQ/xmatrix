import { processExists as processAlive } from "./process-tree.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Machine-wide ownership of an e2e server port for a whole CI run.
 *
 * Probing a port only proves it was free at that instant. The run reserves its
 * port before install and build, and `next start` binds it minutes later, so a
 * probe leaves a window wide enough for another worktree on this host to probe
 * the same port, agree it is free, and lose the race at bind time — which
 * surfaces as "address already in use" and kills a run that had nothing wrong
 * with it. A lease is held for the run's lifetime instead, so two runs can
 * never choose the same port no matter how long the window is.
 *
 * The lease is advisory between our own runs. It does not stop an unrelated
 * process from taking the port, which is what the liveness probe still covers.
 */

const LEASE_DIR_NAME = "xmatrix-ci-port-leases";

export function portLeaseDir(env = process.env) {
  return env.XMATRIX_CI_PORT_LEASE_DIR || path.join(os.tmpdir(), LEASE_DIR_NAME);
}

/**
 * EPERM means the pid exists but belongs to another user: still alive, still
 * holding its port. Only ESRCH proves the holder is gone.
 */
export const leaseHolderAlive = processAlive;

function readLeaseHolder(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(parsed?.pid) ? parsed.pid : null;
  } catch {
    // Unreadable or half-written: treat as abandoned, the pid check cannot
    // vouch for it either way.
    return null;
  }
}

/**
 * Take `port` for `pid`, or report that someone else holds it.
 *
 * O_EXCL makes the create-or-fail atomic across processes; a lease whose
 * holder has died is removed and retried once, so a crashed run never parks a
 * port forever.
 */
export function claimPortLease(port, dir = portLeaseDir(), pid = process.pid) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${port}.lock`);
  const record = JSON.stringify({ pid, port });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, record, { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = readLeaseHolder(file);
      if (holder !== null && holder !== pid && leaseHolderAlive(holder)) return false;
      // Stale or unreadable: drop it and try to take it in the next pass. A
      // concurrent reclaimer may win that race, which the retry re-checks.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Release only our own lease: never unlink a port another run now owns. */
export function releasePortLease(port, dir = portLeaseDir(), pid = process.pid) {
  const file = path.join(dir, `${port}.lock`);
  if (readLeaseHolder(file) !== pid) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lease a port for this run: the preferred one when it is both unleased and
 * unbound, otherwise the next such port in a bounded scan.
 *
 * `isFree` stays injectable so the contract tests can drive the search without
 * binding real sockets.
 */
export async function leasePort({
  preferred,
  dir = portLeaseDir(),
  pid = process.pid,
  isFree,
  span = 200,
}) {
  for (let offset = 0; offset <= span; offset += 1) {
    const port = preferred + offset;
    if (port > 65_535) break;
    if (!claimPortLease(port, dir, pid)) continue;
    if (await isFree(port)) {
      return { port, release: () => releasePortLease(port, dir, pid) };
    }
    releasePortLease(port, dir, pid);
  }
  throw new Error(
    `No free port available in ${preferred}-${Math.min(preferred + span, 65_535)}`,
  );
}
