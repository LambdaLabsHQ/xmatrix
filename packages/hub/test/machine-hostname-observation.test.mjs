import assert from "node:assert/strict";
import test from "node:test";
import { machineHostnameObservation } from "../src/machine-hostname-observation.ts";

test("new hostname-only and older observation shapes establish the same mutable observation", () => {
  assert.deepEqual(machineHostnameObservation({ hostname: " Current " }),
    { hostname: "Current", hostId: "Current", hostName: "Current" });
  assert.deepEqual(machineHostnameObservation({ hostId: "old", hostName: null }),
    { hostname: "old", hostId: "old", hostName: "old" });
  assert.equal(machineHostnameObservation({ hostname: "new", hostName: "old", hostId: "older" }).hostname, "new");
  assert.deepEqual(machineHostnameObservation({}), { hostname: undefined, hostId: "", hostName: undefined });
});

test("malformed observations are rejected even when a different observation is valid", () => {
  for (const value of [null, 1, {}, "", "  ", "\u0000name", "a".repeat(161)]) {
    assert.throws(() => machineHostnameObservation({ hostname: value }), /bounded observation/);
  }
  assert.throws(() => machineHostnameObservation({ hostname: "current", hostId: {} }), /bounded observation/);
  assert.throws(() => machineHostnameObservation({ hostname: "current", hostName: 1 }), /bounded observation/);
});
