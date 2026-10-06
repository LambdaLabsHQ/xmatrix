import { assertDeliveredCountContract } from "./support/machine-daemon-port.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  machineDaemonDeliverable,
  machineDaemonReachable,
} from "../src/runtime-transport/machine-daemon-deliverable.ts";
import {
  MACHINE_DAEMON_ROUTE_CLOSE,
  shouldPersistMachineDaemonOfflineAfterEvict,
} from "../src/runtime-transport/machine-daemon-port.ts";

test("delivered count is the only launch-start fact", () => {
  assertDeliveredCountContract(machineDaemonDeliverable);
});

test("a live owner with an empty claim is still reachable", () => {
  assert.equal(machineDaemonReachable({ owners: 0 }), false);
  assert.equal(machineDaemonReachable({ owners: 1 }), true);
  assert.equal(machineDaemonReachable({}), false);
});

test("last failedDeliver eviction persists catalog offline", () => {
  assert.equal(
    shouldPersistMachineDaemonOfflineAfterEvict(MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver, 0),
    true,
  );
  assert.equal(
    shouldPersistMachineDaemonOfflineAfterEvict(MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver, 1),
    false,
  );
  assert.equal(
    shouldPersistMachineDaemonOfflineAfterEvict(MACHINE_DAEMON_ROUTE_CLOSE.replacedByConnect, 0),
    false,
  );
});
