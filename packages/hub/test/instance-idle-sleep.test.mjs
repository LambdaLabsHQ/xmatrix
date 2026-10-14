import assert from "node:assert/strict";
import { test } from "node:test";

import { MachineControlError } from "@xmatrix/db";
import { INSTANCE_IDLE_SLEEP_MS, presenceRests, reconcileIdleSleeps } from "../src/instance-idle-sleep.ts";
import { channelInstanceSession, recordingAgentInstancePort } from "./support/agent-instance-port.mjs";

/**
 * Idle sleep is the Hub's decision (docs/instance-sleep.md): a Run's presence
 * starts and withdraws its due time, the Channel coordinator issues the sleep
 * when it falls due, and the daemon checks its own facts before acting.
 */
test("a Run rests only while it is not busy, runs no turn and waits on nothing", () => {
  assert.equal(presenceRests("idle", undefined), true);
  assert.equal(presenceRests("online", { status: "idle" }), true);
  assert.equal(presenceRests("busy", { status: "idle" }), false);
  assert.equal(presenceRests("idle", { status: "running" }), false);
  assert.equal(presenceRests("idle", { status: "idle", waiting: { kind: "background", count: 1, sinceMillis: 1 } }), false);
  assert.equal(presenceRests(undefined, undefined), false);
});

test("presence starts and withdraws the sleep only when its rest state or turn changes", async () => {
  const marks = [];
  const { port } = recordingAgentInstancePort({ markResting: async (input) => { marks.push(input); } });
  const session = { ...channelInstanceSession(), run: { ...channelInstanceSession().run, runId: "run-1", instanceStatus: "idle" } };
  const presence = (status, runtimeState) => port.execute(session, { type: "presence_update", status, runtimeState });
  await presence("idle", { status: "idle", updatedAtMillis: 1 });
  await presence("idle", { status: "idle", updatedAtMillis: 1 });
  assert.deepEqual(marks.map((mark) => mark.resting), [true], "a repeated presence costs nothing");
  await presence("busy", { status: "running", updatedAtMillis: 2 });
  await presence("idle", { status: "idle", updatedAtMillis: 3 });
  assert.deepEqual(marks.map((mark) => mark.resting), [true, false, true]);
  assert.deepEqual(marks[0], { runId: "run-1", channelId: "channel", ownerUserId: "owner", resting: true });
});

test("a due sleep is issued once to the Run's daemon with how long it rested; an old daemon is left alone", async () => {
  const due = new Date(Date.now() - 60_000);
  const rows = [
    { run_id: "run-1", owner_user_id: "owner", status: "running", idle_sleep_at: due, instance_id: "instance-1", overdue_ms: "60000",
      metadata_json: { machineId: "machine:a", hostId: "host-a", executionKey: "execution-1" } },
    { run_id: "run-2", owner_user_id: "owner", status: "exited", idle_sleep_at: due, instance_id: "instance-2", overdue_ms: "0",
      metadata_json: { machineId: "machine:a", executionKey: "execution-2" } },
    { run_id: "run-3", owner_user_id: "owner", status: "running", idle_sleep_at: due, instance_id: "instance-3", overdue_ms: "0",
      metadata_json: { machineId: "machine:old", executionKey: "execution-3" } },
  ];
  const queries = [];
  const database = { transaction: async (_context, work) => work({ query: async (query) => { queries.push(query); return rows; } }) };
  const issued = [];
  await reconcileIdleSleeps({}, database, "channel", async (input) => {
    issued.push(input);
    if (input.machineId === "machine:old") throw new MachineControlError("sleep_unavailable", 409, "old daemon");
  });
  assert.match(queries[0].text, /SET idle_sleep_at=NULL/u, "the due time is taken, so a pass issues it once");
  assert.deepEqual(issued.map((input) => input.payload.runId), ["run-1", "run-3"], "an ended Run is not slept");
  assert.deepEqual(issued[0].payload, { type: "machine_sleep_agent", requestId: issued[0].controlId, runId: "run-1",
    executionKey: "execution-1", instanceId: "instance-1", idleForMillis: INSTANCE_IDLE_SLEEP_MS + 60_000 });
  assert.equal(issued[0].commandType, "sleep");
  assert.equal(issued[0].machineId, "machine:a");
  await assert.rejects(reconcileIdleSleeps({}, database, "channel", async () => {
    throw new MachineControlError("forbidden", 403, "other failure");
  }), /other failure/u);
});
