import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresTraceAccessRepository,
  TraceAccessControlError,
} from "../dist/trace-access-control.js";
import { recordingDatabase as database } from "./recording-database.fixture.mjs";

const at = "2026-08-30T08:00:00.000Z";

function row(extra = {}) {
  return { grant_id: "grant-1", owner_user_id: "owner-1", owner_label: null,
    viewer_user_id: "viewer-1", viewer_label: "Viewer", agent_id: "agent-1",
    agent_name: "Agent", instance_id: null, channel_id: null, duration: "permanent",
    status: "pending", reason: "debug", version: 1, requested_at: at,
    decided_at: null, expires_at: null, space_id: "space-1", ...extra };
}

test("Trace request commits one PostgreSQL grant, outbox record, and replay", async () => {
  const db = database((query) => query.name === "trace_access_request_agent_v1"
    ? [{ space_id: "space-1", owner_user_id: "owner-1", name: "Agent" }]
    : query.name === "trace_access_request_insert_v1" ? [row()]
      : query.name === "trace_access_control_head_v1" ? [{ commit_sequence: 7 }] : []);
  const result = await new PostgresTraceAccessRepository(db).request({
    commandId: "command-1", agentId: "agent-1", duration: "permanent", reason: "debug",
    viewerLabel: "Viewer", principal: { kind: "user", id: "viewer-1" },
  });
  assert.equal(result.value.grant.id, "grant-1");
  assert.deepEqual(result.notifications.map((event) => event.type), ["trace_access_requested"]);
  for (const name of ["trace_access_request_insert_v1", "trace_access_outbox_v1",
    "trace_access_replay_write_v1"]) {
    assert.equal(db.calls.some((call) => call.name === name), true, name);
  }
});

test("Trace batch authorization preserves the requested decision order", async () => {
  const db = database((query) => query.name === "trace_access_instance_v2"
    ? [{ owner_user_id: "owner-1", agent_id: "agent-1", channel_id: "channel-1",
        instance_status: "online", run_status: "running" }]
    : query.name === "trace_access_authorize_checks_v4"
      ? [{ ordinality: 1, allowed: true }, { ordinality: 2, allowed: false }] : []);
  const result = await new PostgresTraceAccessRepository(db).authorizeBatch({
    instanceId: "instance-1", checks: [
      { userId: "owner-1", channelId: "channel-1" },
      { userId: "viewer-1", channelId: "channel-2" },
    ],
  });
  assert.deepEqual(result.decisions.map((decision) => decision.allowed), [true, false]);
  const check = db.calls.find((call) => call.name === "trace_access_authorize_checks_v4");
  assert.match(check.text, /owner\.user_id=\$2/u, "the owner must share the event Channel's Space");
  assert.doesNotMatch(check.text, /trace_access_grants/u, "request grants no longer decide visibility");
});

test("a registered Instance is the Agent a trace grant names", async () => {
  const db = database((query) => query.name === "trace_access_instance_v2"
    ? [{ owner_user_id: "owner-1", agent_id: "instance-1", channel_id: "channel-1",
        instance_status: "online", run_status: "running" }]
    : query.name === "trace_access_authorize_checks_v4" ? [{ ordinality: 1, allowed: true }] : []);
  await new PostgresTraceAccessRepository(db).authorizeBatch({ instanceId: "instance-1",
    checks: [{ userId: "viewer-1", channelId: "channel-1" }] });
  const instance = db.calls.find((call) => call.name === "trace_access_instance_v2");
  assert.match(instance.text, /i\.instance_id AS agent_id/u);
  assert.doesNotMatch(instance.text, /agent_profile_id/u);
  const request = database((query) => query.name === "trace_access_request_agent_v1" ? [] : []);
  await assert.rejects(new PostgresTraceAccessRepository(request).request({ commandId: "c", agentId: "instance-1",
    duration: "permanent", principal: { kind: "user", id: "viewer-1" } }));
  const lookup = request.calls.find((call) => call.name === "trace_access_request_agent_v1");
  assert.match(lookup.text, /JOIN data\.run_agent_registrations binding ON binding\.run_id=instance\.run_id/u);
});

test("Trace authority rejects cached PostgreSQL", () => {
  assert.throws(() => new PostgresTraceAccessRepository({ cacheMode: "cached" }),
    (error) => error instanceof TraceAccessControlError &&
      error.code === "cached_authority_forbidden");
});
