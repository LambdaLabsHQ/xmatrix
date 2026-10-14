import assert from "node:assert/strict";
import { test } from "node:test";

import { presenceRests } from "../src/instance-idle-sleep.ts";
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
