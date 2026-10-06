import assert from "node:assert/strict";
import test from "node:test";

import { MachineControlError, rejoinMachine, retireMachine } from "../dist/index.js";
import { recordingDatabase as database } from "./recording-database.fixture.mjs";

test("retiring a Machine tombstones only the owner's row and keeps the first retirement time", async () => {
  const retiredAt = new Date("2026-10-02T07:00:00.000Z");
  const db = database(query => query.name === "machine_retire_v1" ? [{ retired_at: retiredAt }] : []);
  assert.deepEqual(await retireMachine(db, { requestId: "r1", ownerUserId: "alice", machineId: "machine:a" }),
    { machineId: "machine:a", retiredAt: retiredAt.toISOString() });
  const update = db.calls.find(call => call.name === "machine_retire_v1");
  assert.deepEqual(update.values, ["alice", "machine:a"]);
  assert.match(update.text, /COALESCE\(retired_at,clock_timestamp\(\)\)/u);
  assert.match(update.text, /owner_user_id=\$1 AND machine_id=\$2/u);

  await assert.rejects(retireMachine(database(() => []), { requestId: "r2", ownerUserId: "bob", machineId: "machine:a" }),
    error => error instanceof MachineControlError && error.code === "machine_not_found" && error.status === 404);
});

test("rejoining clears only a retired row of the owner and reports whether it did", async () => {
  const db = database(query => query.name === "machine_rejoin_v1" ? [{ machine_id: "machine:a" }] : []);
  assert.deepEqual(await rejoinMachine(db, { requestId: "r1", ownerUserId: "alice", machineId: "machine:a" }),
    { machineId: "machine:a", rejoined: true });
  const update = db.calls.find(call => call.name === "machine_rejoin_v1");
  assert.deepEqual(update.values, ["alice", "machine:a"]);
  assert.match(update.text, /retired_at IS NOT NULL/u);
  assert.deepEqual(await rejoinMachine(database(() => []), { requestId: "r2", ownerUserId: "alice", machineId: "machine:b" }),
    { machineId: "machine:b", rejoined: false });
});
