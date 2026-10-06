import assert from "node:assert/strict";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";

import {
  playwrightPortIsFree,
  preferredPlaywrightPort,
} from "./ci-playwright-port.mjs";
import { leasePort, portLeaseDir } from "./ci-port-lease.mjs";

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => resolve(server));
    server.listen(port);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("GitHub runs prefer the fixed port, local runs scope it to the process", () => {
  assert.equal(preferredPlaywrightPort({ GITHUB_ACTIONS: "true" }, 4242), 24_611);
  // CI=1 alone is a local pre-commit stage; it must not collapse onto 24611.
  const local = preferredPlaywrightPort({ CI: "1" }, 4242);
  assert.notEqual(local, 24_611);
  assert.equal(local, preferredPlaywrightPort({ CI: "1" }, 4242));
});

test("a free preferred port is taken as is", async () => {
  const probe = await listenOn(0);
  const free = probe.address().port;
  await close(probe);

  const lease = await leasePort({ preferred: free, isFree: playwrightPortIsFree });
  try {
    assert.equal(lease.port, free);
  } finally {
    lease.release();
  }
});

test("a port held by a leftover server is stepped over, not reused", async () => {
  const leftover = await listenOn(0);
  const held = leftover.address().port;
  let lease;
  try {
    lease = await leasePort({ preferred: held, isFree: playwrightPortIsFree });
    assert.notEqual(lease.port, held);
    // The replacement has to be usable, not just different.
    const server = await listenOn(lease.port);
    await close(server);
  } finally {
    lease?.release();
    await close(leftover);
  }
});

test("the lease outlives the probe, so a second run cannot pick the same port", async () => {
  const probe = await listenOn(0);
  const free = probe.address().port;
  await close(probe);

  const first = await leasePort({ preferred: free, isFree: playwrightPortIsFree });
  try {
    // Nothing is listening on `first.port` — a bare probe would hand it out
    // again. The lease is what makes the second run step aside.
    assert.equal(await playwrightPortIsFree(first.port), true);
    const second = await leasePort({
      preferred: free,
      pid: process.ppid,
      isFree: playwrightPortIsFree,
    });
    try {
      assert.notEqual(second.port, first.port);
    } finally {
      second.release();
    }
  } finally {
    first.release();
  }
});

test("leases are visible across worktrees, not scoped to one checkout", () => {
  assert.ok(path.isAbsolute(portLeaseDir({})));
  assert.ok(!portLeaseDir({}).startsWith(process.cwd()));
});
