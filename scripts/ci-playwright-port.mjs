import { createServer } from "node:net";

/**
 * Preferred e2e server port for this run.
 *
 * GitHub-hosted jobs each get their own machine, but ours are self-hosted:
 * several runners share one host, so a fixed port is shared state. Local
 * pre-commit checks have the same problem across worktrees, which is why they
 * already scope the port to the process.
 */
export function preferredPlaywrightPort(env = process.env, pid = process.pid) {
  return env.GITHUB_ACTIONS ? 24_611 : 30_000 + (pid % 15_000);
}

/** Resolve once nothing is listening on `port`, on any interface. */
export function playwrightPortIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    // No host: a listener bound to 0.0.0.0 or to 127.0.0.1 both make this fail.
    probe.listen(port);
  });
}

/**
 * Choosing the port is `leasePort` in ci-port-lease.mjs, which walks up from
 * the preferred port using this probe.
 *
 * A cancelled CI run can leave its `next start` holding the port: the next run
 * then fails with "is already used" before Playwright ever runs the webServer
 * command, and the failure looks like a product regression. Stepping aside also
 * lets two runners on one host test at the same time. Reusing a leftover
 * server is never an option — it serves the previous run's build.
 *
 * An ephemeral fallback used to cover the "preferred port is taken" case, but
 * an OS-assigned port is only free at the instant it is handed out; it is
 * closed again before `next start` binds, so it could still collide with a
 * neighbouring worktree. The lease decides ownership instead, and this probe is
 * left to answer the one question it can: is anything listening right now.
 */
