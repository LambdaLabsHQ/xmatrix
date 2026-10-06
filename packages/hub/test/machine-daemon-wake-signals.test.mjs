import assert from "node:assert/strict";
import test from "node:test";

import {
  MachineDaemonWakeSignals,
} from "../src/machine-daemon-wake-signals.ts";

test("Machine Daemon wake survives the issue-before-long-poll race exactly once", async () => {
  const signals = new MachineDaemonWakeSignals();
  signals.wake("user-1", "machine-1", "host-1");

  assert.equal(await signals.wait("user-1", "machine-1", "host-1", 20), true);
  assert.equal(await signals.wait("user-1", "machine-1", "host-1", 2), false);
});

test("Machine Daemon wake releases all matching long polls without crossing machine scopes", async () => {
  const signals = new MachineDaemonWakeSignals();
  const first = signals.wait("user-1", "machine-1", "host-1", 50);
  const second = signals.wait("user-1", "machine-1", "host-1", 50);
  const other = signals.wait("user-1", "machine-2", "host-1", 5);

  signals.wake("user-1", "machine-1", "host-1");
  assert.deepEqual(await Promise.all([first, second, other]), [true, true, false]);
  assert.deepEqual(signals.snapshot(), { pending: 0, waitingScopes: 0 });
});

test("Machine Daemon pending wake cache expires and remains bounded", async () => {
  let now = 1_000;
  const signals = new MachineDaemonWakeSignals(() => now, 30, 2);
  signals.wake("user-1", "machine-1", "host-1");
  signals.wake("user-1", "machine-2", "host-1");
  signals.wake("user-1", "machine-3", "host-1");
  assert.equal(signals.snapshot().pending, 2);
  assert.equal(await signals.wait("user-1", "machine-1", "host-1", 2), false);

  now += 31;
  signals.wake("user-1", "machine-4", "host-1");
  assert.equal(signals.snapshot().pending, 1);
  assert.equal(await signals.wait("user-1", "machine-3", "host-1", 2), false);
  assert.equal(await signals.wait("user-1", "machine-4", "host-1", 2), true);
});
