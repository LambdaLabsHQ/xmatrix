import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresScheduledRunCleanup,
} from "../src/postgres-scheduled-run-cleanup.ts";

const occurrence = {
  id: "occurrence-1", run_id: "run-1", instance_id: "instance-1",
  owner_user_id: "owner-1",
};

test("PostgreSQL scheduled cleanup reads and terminals the exact Run Instance", async () => {
  const mutations = [];
  const repository = {
    async getInstance(input) {
      assert.equal(input.actorUserId, "owner-1");
      return { instance: { instanceId: "instance-1", runId: "run-1",
        status: "running", version: 7 } };
    },
    async mutate(input) { mutations.push(input); return {}; },
  };
  const cleanup = new PostgresScheduledRunCleanup(
    {}, { repository },
  );
  await cleanup.abandon(occurrence, "dispatch_failed");

  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0], {
    commandId: "scheduled:abandon:instance-1", actorUserId: "owner-1",
    at: mutations[0].at, kind: "instance_transition", instanceId: "instance-1",
    expectedRunId: "run-1", expectedVersion: 7, status: "offline", terminal: true,
  });
  assert.equal(Number.isFinite(Date.parse(mutations[0].at)), true);
});

test("PostgreSQL scheduled cleanup never terminals a rebound or already-offline Instance", async () => {
  let runId = "run-2";
  let status = "running";
  let mutations = 0;
  const repository = {
    async getInstance() { return { instance: { runId, status, version: 2 } }; },
    async mutate() { mutations += 1; return {}; },
  };
  const cleanup = new PostgresScheduledRunCleanup(
    {}, { repository },
  );
  await cleanup.abandon(occurrence, "rebound");
  runId = "run-1";
  status = "offline";
  await cleanup.abandon(occurrence, "already_offline");
  assert.equal(mutations, 0);
});
