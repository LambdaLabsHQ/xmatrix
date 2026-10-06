import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresSchedulerControlRepository,
  SchedulerControlError,
} from "../dist/scheduler-control.js";
import { dedicatedPlacementRow, recordingDatabase as database } from "./recording-database.fixture.mjs";

function placed(respond) {
  return (query) => query.name === "space_placement_resolve_v1"
    ? [dedicatedPlacementRow()]
    : query.name === "scheduler_entity_route_source_v1"
      ? [{ route_version: 9, updated_at: "2026-08-30T00:00:00.000Z" }]
      : query.name === "entity_space_route_placement_fence_v1"
        ? [{ shard_id: "shard-1", placement_epoch: 7 }]
        : respond(query);
}

const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

test("scheduler control acquires a fenced Space claim in PostgreSQL", async () => {
  const row = { claim_id: "claim-1", space_id: "space-1", scope: "channel:channel-1",
    intent: "respond", holder_user_id: "user-1", holder_json: { userId: "user-1" },
    idempotency_key: "key-1", status: "active", version: 1,
    created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:00.000Z",
    expires_at: future, released_at: null, released_by_user_id: null };
  const db = database(placed((query) => query.name === "scheduler_space_role_v1"
    ? [{ role: "member" }]
    : query.name === "scheduler_claim_scope_lock_v1" ? [{ locked: true }]
      : query.name === "scheduler_claim_insert_v1" ? [row]
        : query.name === "scheduler_control_head_v1" ? [{ commit_sequence: 10 }] : []));
  const value = await new PostgresSchedulerControlRepository(db).acquireClaim({
    commandId: "command-3", spaceId: "space-1", actorUserId: "user-1",
    scope: "channel:channel-1", intent: "respond", idempotencyKey: "key-1",
  });
  assert.deepEqual({ id: value.claim.id, reused: value.reused },
    { id: "claim-1", reused: false });
  assert.equal(db.calls.some((call) => call.name === "scheduler_claim_scope_lock_v1"), true);
});

test("scheduler control rejects cached PostgreSQL", () => {
  assert.throws(() => new PostgresSchedulerControlRepository({ cacheMode: "cached" }),
    (error) => error instanceof SchedulerControlError &&
      error.code === "cached_authority_forbidden");
});
