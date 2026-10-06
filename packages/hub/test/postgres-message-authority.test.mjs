import assert from "node:assert/strict";

import test from "node:test";
import { registeredRunRows } from "../../db/test/registered-run.fixture.mjs";

import {
  openPostgresMessageRequestScope,
  postgresMessageAppend,
  postgresMessageAcknowledge,
  postgresMessageErrorResponse,
  postgresMessageHistory,
  postgresProductMessage,
} from "../src/postgres-message-authority.ts";
import {
  postgresMessageAttachmentAuthorityRequest,
} from "../src/postgres-message-attachment-authority.ts";
import {
  POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
} from "../src/postgres-message-database-policy.ts";
import { recordingDatabase } from "./support/postgres-database.mjs";

test("PostgreSQL Message checkout wait is bounded below the UI cancellation budget", async () => {
  assert.equal(POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS, 8_000);

});

test("PostgreSQL history presents an authorized archived Channel through the Hub contract", async () => {
  const statements = [];
  const session = {
    cacheMode: "disabled",
    openSession() { return session; },
    async close() {},
    async transaction(context, callback) {
      return callback({ async query(query) {
        statements.push({ name: query.name, context, values: query.values });
        if (query.name === "channel_space_directory_resolve_placed_v1") return [{
          channel_id: "channel-1", space_id: "space-1", shard_id: "shard-0",
          placement_epoch: 1, entity_version: 1, placement_space_id: "space-1",
          placement_shard_id: "shard-0", placement_placement_epoch: 1, placement_state: "active",
          placement_target_shard_id: null, placement_plan_class: "shared",
        }];
        if (query.name === "message_history_page_v3") return [{
          history_authorized: true, acknowledged_sequence: 0, content_revision: 3,
          history_head_sequence: 30, message_id: null,
        }];
        return [];
      } });
    },
  };
  const result = await postgresMessageHistory({ RELAY_POSTGRES_SHARD_ID: "shard-0" }, {
    channelId: "channel-1", limit: 10, principal: { kind: "user", id: "user-1" },
  }, { database: session });
  // A warm history request is two statements: the directory read that selects
  // the shard, then the fenced page read that authorizes the reader.
  assert.deepEqual(statements.map((statement) => statement.name),
    ["channel_space_directory_resolve_placed_v1", "message_history_page_v3"]);
  assert.equal(statements[0].context.placement, undefined);
  assert.deepEqual(statements[1].context.placement,
    { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 });
  assert.equal(statements[1].context.statement, "single_read");
  assert.deepEqual(statements[1].values.slice(6, 8), ["user", "user-1"],
    "the page authorizes the caller's own principal");
  assert.deepEqual(result, {
    channelId: "channel-1", messages: [], hasMore: false, historyHeadSequence: 30,
    contentAuthority: { protocolVersion: 1, contentRevision: 3 },
    principalAckedSequence: 0,
    fullHistory: {
      sources: ["postgres-authority", "immutable-payload-objects"],
      independentOfLongLivedProjection: true,
      admissibleForSteadyState: true,
      canCompleteWithoutLongLivedProjection: true,
    },
  });
});

test("PostgreSQL Message request scope opens and closes one caller-owned session", async () => {
  let opens = 0;
  let closes = 0;
  const session = {
    cacheMode: "disabled",
    openSession() { throw new Error("nested request scope"); },
    async transaction() { throw new Error("not used"); },
    async health() { throw new Error("not used"); },
    async close() { closes += 1; },
  };
  const root = {
    cacheMode: "disabled",
    openSession() { opens += 1; return session; },
    async transaction() { throw new Error("not used"); },
    async health() { throw new Error("not used"); },
  };
  const scope = openPostgresMessageRequestScope({}, { database: root });
  assert.equal(scope.database, session);
  assert.equal(scope.recoveryDatabase, root);
  await scope.close();
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

/** The Agent Instance a Codex Run sends as. */
const CODEX_SENDER_IDENTITY = {
  instance_id: "instance-1", name: "Codex", runtime: "codex",
  owner_user_id: "owner-1", owner_email: "owner@example.test",
  metadata_json: {}, version: 4,
};

function openChannelRow(channelId) {
  return { channel_id: channelId, space_id: "space-1", mode: "open", metadata_json: {} };
}

/**
 * A PostgreSQL session that commits one Agent message append. `rows` answers
 * the statements a test varies (the Run proof, the target Channel, the sender
 * identity); the sequence reservation follows `sequenceChannelId`, and the
 * commit lands in `commitChannelId`.
 */
function agentAppendDatabase({ calls = [], sequenceChannelId, commitChannelId = sequenceChannelId, rows }) {
  return {
    cacheMode: "disabled",
    async transaction(_context, callback) {
      return callback({
        async query(query) {
          const admission = registeredRunRows(query);
          if (admission) return admission;
          calls.push(query);
          const answered = rows(query);
          if (answered) return answered;
          if (query.name === "message_prepare_observed_head_v1") return [{ sequence: 0 }];
          if (query.name === "message_sequence_reservation_read_v1") return [];
          if (query.name === "message_sequence_allocate_v1") return [{ allocated_sequence: 1 }];
          if (query.name === "message_sequence_reservation_insert_v1" ||
              query.name === "message_sequence_reservation_verify_v1") return [{
            channel_id: sequenceChannelId, sequence: 1, state: "reserved", fact_digest: null,
          }];
          if (query.name === "message_append_idempotency_read_v1" ||
              query.name === "message_append_identity_conflict_v1") return [];
          if (query.name === "message_append_commit_facts_v5") return [{
            search_rank: "pg:00000000000000000001", content_revision: 0, channel_id: commitChannelId,
          }];
          if (query.name === "message_append_publish_unmetered_v1") return [{
            status: null, grace_until: null, seat_quantity: null, seat_count: null,
            prior_free_message_count: 0, free_message_count: 1,
            accepted: true, channel_id: commitChannelId, sequence_confirmed: true,
            result_json: JSON.parse(query.values[4]),
          }];
          if (query.name === "run_registration_authority_mode_v3" ||
              query.name === "run_registration_access_binding_v3") return [];
          throw new Error(`unexpected query ${query.name}`);
        },
      });
    },
  };
}

/** An open channel-1 and the Codex sender: what every Agent append reads besides its Run. */
function agentChannelRows(query) {
  if (query.name?.startsWith("channel_capability_message_")) return [openChannelRow("channel-1")];
  if (query.name === "message_sender_agent_identity_v3") return [CODEX_SENDER_IDENTITY];
  return null;
}

/** An open Channel, no attention candidates, and a clean append preflight. */
function openAppendRows(channelId) {
  return (query) => {
    if (query.name?.startsWith("channel_capability_message_")) return [openChannelRow(channelId)];
    if (query.name === "message_attention_candidates_v5") return [{ candidates: [] }];
    if (query.name === "message_append_preflight_v4") return [{
      command_kind: null, request_digest: null, result_json: null, channel_id: channelId,
      channel_mode: "open", channel_metadata_json: {}, channel_authorized: true, duplicate_exists: false,
    }];
    return null;
  };
}

for (const scenario of [
  { name: "ordinary Agent" },
  { name: "management mention", routedAs: "management_assistant_mention" },
  { name: "stale management generation", routedAs: "management_assistant_mention", configVersion: 3 },
  { name: "disabled management", routedAs: "management_assistant_mention", enabled: false },
  { name: "management changed before commit", routedAs: "management_assistant_mention", changeAtCommit: true },
  { name: "wrong management Space", routedAs: "management_assistant_mention", managementSpaceId: "other" },
  { name: "missing management generation", routedAs: "management_assistant_mention", generation: null },
  { name: "Channel About cannot post", routedAs: "management_channel_about", error: "agent_run_forbidden" },
]) test(`PostgreSQL sender identity: ${scenario.name}`, async () => {
  const calls = [];
  const observations = [];
  const targetChannel = "channel-1";
  const database = agentAppendDatabase({ calls, sequenceChannelId: targetChannel, commitChannelId: "channel-1",
    rows: (query) => {
      if (query.name === "message_append_run_proof_v3") return [{
        owner_user_id: "owner-1", channel_id: "channel-1",
        run_status: "running", instance_status: "busy", instance_channel_id: "channel-1",
        channel_instance_id: "7", metadata_json: { executionKey: "execution-1",
          ...(scenario.routedAs ? { routedAs: scenario.routedAs,
            managementSpaceId: scenario.managementSpaceId ?? "space-1",
            managementConfigGeneration: scenario.generation === null ? undefined : 2 } : {}),
        },
      }];
      if (query.name === "message_management_delegate_config_v2") return [{
        version: scenario.changeAtCommit && calls.filter(
          (call) => call.name === query.name).length > 1 ? 3 : scenario.configVersion ?? 2,
        config_json: { enabled: scenario.enabled ?? true },
      }];
      return agentChannelRows(query);
    } });
  const append = postgresMessageAppend({
    RELAY_AUTHORITY_OBSERVABILITY_ENABLED: "true",
    POSTGRES_COORDINATION_OBSERVABILITY_SAMPLE_RATE: "1",
    RELAY_AUTHORITY_OBSERVABILITY_AE: { writeDataPoint: (point) => observations.push(point) },
  }, targetChannel, {
    commandId: "command-1", messageId: "message-1", channelId: targetChannel,
    body: "hello", principal: { kind: "agent", id: "instance-1" },
    agentSendFingerprint: "1".repeat(64), // Untrusted command metadata is not HTTP evidence.
    agentRunProof: {
      runId: "run-1", executionKey: "execution-1", instanceId: "instance-1",
    },
    senderSnapshot: {
      identityId: "attacker", instanceId: "attacker", channelInstanceId: "999",
      label: "Attacker:999", goal: { status: "working", summary: "Review" },
      unreviewed: "discard me",
      registration: { ownerUserId: "attacker", machineId: "attacker", harness: "codex" },
      xmatrixManagementDelegate: { agentId: "attacker" }, managementActivityKind: "focus-action",
    },
  }, {
    database, spaceId: "space-1",
    ...(scenario.name === "ordinary Agent" ? { agentSendFingerprint: "2".repeat(64) } : {}),
    placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 },
  });
  if (scenario.configVersion || scenario.enabled === false || scenario.changeAtCommit ||
      scenario.managementSpaceId || scenario.generation === null || scenario.error) {
    await assert.rejects(append, (error) => error.code ===
      (scenario.error ?? "management_delegate_message_forbidden"));
    assert.equal(calls.some((query) => query.name === "message_append_commit_facts_v5"), false);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].blobs[0], "message_append");
    assert.equal(observations[0].blobs[1], "error");
    return;
  }
  const result = await append;
  assert.equal(result.agentSendFingerprint, scenario.name === "ordinary Agent" ? "2".repeat(64) : undefined);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].blobs[1], "ok");
  assert.equal(observations[0].doubles.length, 8);
  assert.partialDeepStrictEqual(result.senderSnapshot, {
    identityId: scenario.routedAs ? "xmatrix:management" : "instance-1",
    agentId: "instance-1", instanceId: "instance-1",
    channelInstanceId: "7", instanceLabel: scenario.routedAs ? "xMatrix" : "Codex:7",
    label: scenario.routedAs ? "xMatrix" : "Codex:7",
    goal: { status: "working", summary: "Review" },
  });
  assert.equal(result.senderSnapshot.unreviewed, undefined);
  assert.deepEqual(result.senderSnapshot.registration, scenario.routedAs ? undefined : {
    ownerUserId: "owner-1", machineId: "machine-1", harness: "codex",
  });
  assert.equal(result.senderSnapshot.managementActivityKind, undefined);
  assert.deepEqual(result.senderSnapshot.xmatrixManagementDelegate, scenario.routedAs ? {
    agentId: "instance-1", agentName: "Codex", runId: "run-1", instanceId: "instance-1",
    managementSpaceId: "space-1", managementConfigGeneration: 2,
  } : undefined);
  if (scenario.routedAs) {
    assert.equal(result.senderSnapshot.name, "xMatrix");
    assert.equal(result.senderSnapshot.agentName, "xMatrix");
    assert.equal(result.senderSnapshot.avatarUrl, "/brand/xmatrix-management-icon.png");
  }
  assert.equal(calls.filter((query) => query.name === "message_append_run_proof_v3").length, 2);
});

test("a committed Agent message carries the Instance row's presentation", async () => {
  /* The header's tags died on this exact path and nothing caught it: the only
     guard quoted the route's source text, and the one end-to-end test runs on
     the Durable Object authority, where the read was never gated off. So assert
     the committed snapshot itself, on the PostgreSQL path, with a fake row.

     The row wins key by key, and the caller's overlay survives only where the
     row carries nothing -- an Instance whose first message outruns its first
     presentation write still stamps a header. */
  const database = agentAppendDatabase({ sequenceChannelId: "channel-1", rows: (query) => {
      if (query.name === "message_append_run_proof_v3") return [{
        owner_user_id: "owner-1", channel_id: "channel-1",
        run_status: "running", instance_status: "busy", instance_channel_id: "channel-1",
        channel_instance_id: "7", metadata_json: { executionKey: "execution-1" },
        presentation_json: {
          model: "gpt-6-astra",
          effort: "high",
          statusChips: [{ id: "model", label: "Model", value: "gpt-6-astra" }],
        },
      }];
      return agentChannelRows(query);
    } });
  const result = await postgresMessageAppend({}, "channel-1", {
    commandId: "command-presentation-1", messageId: "message-presentation-1",
    channelId: "channel-1", body: "tagged", principal: { kind: "agent", id: "instance-1" },
    agentRunProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" },
    senderSnapshot: {
      // Stale against the row, and therefore must lose.
      model: "gpt-5",
      // Absent from the row, and therefore must survive.
      gitBranch: "feat/hub-instance-presentation-row",
    },
  }, {
    database, spaceId: "space-1",
    placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 },
  });

  assert.equal(result.senderSnapshot.model, "gpt-6-astra");
  assert.equal(result.senderSnapshot.effort, "high");
  assert.deepEqual(result.senderSnapshot.statusChips,
    [{ id: "model", label: "Model", value: "gpt-6-astra" }]);
  assert.equal(result.senderSnapshot.gitBranch, "feat/hub-instance-presentation-row");
});

test("Message attachments require the PostgreSQL binding", async () => {
  assert.equal((await postgresMessageAttachmentAuthorityRequest({}, {})).status, 503);
});

test("PostgreSQL message attachment authority uses the fleet-routed database", async () => {

  const calls = [];
  const database = recordingDatabase((query) => {
    if (query.name === "channel_space_directory_resolve_placed_v1") {
      return [{
        channel_id: "c", space_id: "s", shard_id: "shard-1",
        placement_epoch: 2, entity_version: 1,
        placement_space_id: "s", placement_shard_id: "shard-1",
        placement_placement_epoch: 2, placement_state: "active",
        placement_target_shard_id: null, placement_plan_class: "shared",
      }];
    }
    if (query.name === "space_placement_resolve_v1") throw new Error("Query read timeout");
    return [];
  }, calls);
  let closed = false;
  database.openSession = () => database;
  database.close = async () => { closed = true; };
  const response = await postgresMessageAttachmentAuthorityRequest({
    RELAY_POSTGRES: { connectionString: "postgres://directory" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
    RELAY_POSTGRES_SHARD_1: { connectionString: "postgres://shard-1" },
    RELAY_POSTGRES_SHARD_1_ID: "shard-1",
  }, {
    channelId: "c", messageId: "m", attachmentId: "a",
    principal: { kind: "user", id: "u" },
  }, { database });
  assert.equal(response.status, 404, "the routed request reaches the capability check");
  assert.deepEqual(calls.filter((call) => call.operation).map((call) => call.placement),
    [undefined, { spaceId: "s", shardId: "shard-1", placementEpoch: 2 }]);
  assert.equal(closed, true);
});

test("PostgreSQL Message failures are fail-closed", async () => {
  const response = postgresMessageErrorResponse(new Error("postgres unavailable"));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "PostgreSQL message request failed",
    code: "postgres_message_authority_internal_error",
    retryable: false,
  });
});

test("a message request for a Channel that does not exist answers 404, not a failed request", async () => {
  const session = {
    cacheMode: "disabled",
    openSession() { return session; },
    async close() {},
    async transaction(_context, callback) {
      return callback({ async query() { return []; } });
    },
  };
  const failure = await postgresMessageHistory({ RELAY_POSTGRES_SHARD_ID: "shard-0" }, {
    channelId: "no-such-channel", limit: 10, principal: { kind: "agent", id: "instance-1" },
  }, { database: session }).then(() => undefined, (error) => error);
  assert.ok(failure, "history of an unknown Channel must not succeed");
  const response = postgresMessageErrorResponse(failure);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Channel not found", code: "channel_not_found", retryable: false,
  });
});

test("PostgreSQL history maps its bounded Thread summary onto the canonical message", () => {
  const message = postgresProductMessage({
    messageId: "root-1", channelId: "parent-1", sequence: 7,
    senderKind: "user", senderId: "user-1", sentAt: "2026-09-02T00:00:00.000Z",
    threadSummary: {
      channelId: "thread-1", updatedAt: "2026-09-02T01:00:00.000Z", replyCount: 1,
      replies: [{
        messageId: "reply-1", channelId: "thread-1", sequence: 2,
        senderKind: "user", senderId: "user-2", sentAt: "2026-09-02T01:00:00.000Z",
      }],
    },
  });

  assert.deepEqual({ ...message.thread, replies: undefined }, {
    channelId: "thread-1", updatedAt: "2026-09-02T01:00:00.000Z", replyCount: 1,
    replies: undefined,
  });
  assert.partialDeepStrictEqual(message.thread.replies[0], {
    messageId: "reply-1", channelId: "thread-1", sequence: 2,
  });
});

test("a recalled message is presented under its author's name, not a raw id", () => {
  const base = { channelId: "c", sequence: 3, sentAt: "2026-09-28T19:00:00.000Z",
    recalledAt: "2026-09-28T19:01:00.000Z" };
  const agent = postgresProductMessage({ ...base, messageId: "a", senderKind: "agent",
    senderId: "birth-channel:8", tombstoneSender: { label: "claude:8", name: "claude",
      agentName: "claude", instanceId: "birth-channel:8", channelInstanceId: "8", instanceLabel: "claude:8" } });
  assert.partialDeepStrictEqual(agent, { body: "", recalledAt: base.recalledAt,
    from: { kind: "agent", label: "claude:8", agentName: "claude", instanceId: "birth-channel:8" } });
  const human = postgresProductMessage({ ...base, messageId: "h", senderKind: "user",
    senderId: "user-1", tombstoneSender: { label: "Yiming Hu", name: "Yiming Hu", userId: "user-1" } });
  assert.partialDeepStrictEqual(human.from, { kind: "user", label: "Yiming Hu", userId: "user-1",
    identityId: "user:user-1" });
  // An author the shard can no longer resolve keeps its stable id.
  const unknown = postgresProductMessage({ ...base, messageId: "u", senderKind: "user", senderId: "gone" });
  assert.equal(unknown.from.label, "gone");
});

test("PostgreSQL history supplies attachment kinds and exact copy coordinates to CLI and Web", () => {
  const attachments = [
    ["image/png", "image"], ["video/mp4", "video"],
    ["text/markdown", "markdown"], ["application/pdf", "file"],
  ].map(([mimeType]) => ({
    id: mimeType, name: "attachment", mimeType, size: 3, version: 4,
    channelId: "parent", messageId: "original", contentHash: "a".repeat(64),
  }));
  const message = postgresProductMessage({
    messageId: "thread-root:thread-1", channelId: "thread-1", attachments,
    threadSummary: { channelId: "nested", updatedAt: "2026-09-10", replyCount: 1,
      replies: [{ channelId: "nested", messageId: "reply-1", attachments }] },
  });
  assert.deepEqual(message.attachments.map((attachment) => attachment.kind),
    ["image", "video", "markdown", "file"]);
  assert.partialDeepStrictEqual(message.attachments[0], {
    channelId: "thread-1", messageId: "thread-root:thread-1", version: 4,
  });
  assert.equal(message.thread.replies[0].attachments[0].messageId, "reply-1");
  assert.equal(attachments[0].messageId, "original");
});

function acknowledgeDatabase() {
  const writes = [];
  return {
    writes,
    cacheMode: "disabled",
    async transaction(_context, callback) {
      return callback({ async query(query) {
        if (query.name === "channel_space_directory_resolve_v2") return [{
          channel_id: "channel-1", space_id: "space-1", shard_id: "shard-0",
          placement_epoch: 1, entity_version: 1,
        }];
        if (query.name === "space_placement_resolve_v1") return [{
          space_id: "space-1", shard_id: "shard-0", placement_epoch: 1,
          state: "active", plan_class: "shared",
        }];
        if (query.name?.startsWith("channel_capability_message_")) return [{
          channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {},
        }];
        if (query.name === "message_ack_head_v1") return [{ sequence: 9 }];
        if (query.name === "message_ack_target_v1") return [{ sequence: 4 }];
        if (query.name === "message_ack_idempotency_write_v1") writes.push(query);
        return [];
      } });
    },
  };
}

test("PostgreSQL ACK accepts omitted sequence and binds a message-id target in its digest", async () => {
  const db = acknowledgeDatabase();
  const base = { commandId: "ack-1", principal: { kind: "agent", id: "instance-1" } };
  const latest = await postgresMessageAcknowledge({ RELAY_POSTGRES_SHARD_ID: "shard-0" }, "channel-1", base, { database: db });
  assert.equal(latest.ackedSequence, 9);
  const addressed = await postgresMessageAcknowledge({ RELAY_POSTGRES_SHARD_ID: "shard-0" }, "channel-1",
    { ...base, commandId: "ack-2", messageId: "summon-message" }, { database: db });
  assert.equal(addressed.ackedSequence, 4);
  assert.notEqual(db.writes[0].values[2], db.writes[1].values[2]);
  const explicit = await postgresMessageAcknowledge({ RELAY_POSTGRES_SHARD_ID: "shard-0" }, "channel-1",
    { ...base, commandId: "ack-3", sequence: 3 }, { database: db });
  assert.equal(explicit.ackedSequence, 3);
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256").update(
    '{"channelId":"channel-1","principal":{"id":"instance-1","kind":"agent"},"sequence":3}',
  ).digest("hex");
  assert.equal(db.writes[2].values[2], expected);
});

function crossChannelAppendDatabase(calls) {
  return agentAppendDatabase({ calls, sequenceChannelId: "channel-away", rows: (query) => {
    if (query.name === "message_append_run_proof_v3") return [{
      owner_user_id: "owner-1", channel_id: "channel-home",
      run_status: "running", instance_status: "busy", instance_channel_id: "channel-home",
      channel_instance_id: "3", metadata_json: { executionKey: "execution-1" },
    }];
    if (query.name === "agent_channel_registered_run_access_v2") return [{
      owner_user_id: "owner-1", channel_id: "channel-home", status: "running",
      metadata_json: { executionKey: "execution-1" }, instance_channel_id: "channel-home",
    }];
    if (query.name?.startsWith("channel_capability_")) return [{
      channel_id: "channel-away", space_id: "space-1", mode: "open", metadata_json: {},
      version: 1, archived_at: null,
    }];
    if (query.name === "message_append_run_origin_v1") return [{ source_message_id: "asked-1" }];
    if (query.name === "message_sender_agent_identity_v3") return [{
      instance_id: "instance-1", name: "claude", runtime: "claude",
      owner_user_id: "owner-1", owner_email: "owner@example.test", metadata_json: {}, version: 1,
    }];
    return null;
  } });
}

test("an Agent message written outside its own Channel is committed as a link to where it came from", async () => {
  const calls = [];
  const result = await postgresMessageAppend({}, "channel-away", {
    commandId: "command-link-1", messageId: "message-link-1", channelId: "channel-away",
    body: "can someone here confirm the schema?", principal: { kind: "agent", id: "instance-1" },
    agentRunProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" },
    // A Run cannot choose its own origin.
    senderSnapshot: { originChannelId: "channel-forged", originMessageId: "forged" },
  }, {
    database: crossChannelAppendDatabase(calls), spaceId: "space-1",
    placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 },
  });
  assert.equal(result.senderSnapshot.originChannelId, "channel-home");
  assert.equal(result.senderSnapshot.originMessageId, "asked-1");
  assert.equal(result.senderSnapshot.instanceLabel, "claude:3");
  const insert = calls.find((query) => query.name === "message_append_commit_facts_v5");
  assert.deepEqual(insert.values.slice(21, 24), ["channel-home", "asked-1", "run-1"]);
});

test("a reply to a link is relayed into the link's Channel as work, once, under the link owner", async () => {
  const { crossChannelReplyOrigin, relayCrossChannelReply } =
    await import("../src/product-cross-channel-reply.ts");
  assert.equal(crossChannelReplyOrigin({ channelId: "a", messageId: "m" }), undefined,
    "a relay without the owner whose authority it needs is not a relay");
  assert.deepEqual(crossChannelReplyOrigin({ channelId: "a", messageId: "m", ownerUserId: "o",
    replier: { kind: "user", label: "Ada", agentId: "x", instanceId: "y" } }).replier,
    { kind: "user", label: "Ada" }, "only an Agent replier names an Instance");
  const appended = [];
  await relayCrossChannelReply({
    env: {}, channelId: "channel-away", messageId: "reply-9", body: "yes, v84 is live",
    origin: { channelId: "channel-home", messageId: "link-1", ownerUserId: "owner-1",
      replier: { kind: "agent", label: "claude:2", avatarUrl: "https://a/claude.png",
        agentId: "agent-7", instanceId: "channel-home:2" },
      requesterInstanceId: "channel-home:1" },
  }, {
    append: async (_env, channelId, command) => {
      appended.push({ channelId, command });
      return Response.json({ sequence: 12, committedAt: "2026-09-25T15:00:00.000Z" });
    },
  });
  assert.equal(appended.length, 1);
  const [{ channelId, command }] = appended;
  assert.equal(channelId, "channel-home");
  assert.equal(command.messageId, "link-reply:reply-9", "a retried post-commit appends the same message");
  assert.equal(command.commandId, command.messageId);
  assert.deepEqual(command.principal, { kind: "user", id: "owner-1" });
  assert.equal(command.residual.appMetadata.xmatrixProvenance, "cross_channel_reply",
    "never a system fact, which an Agent would read as context instead of work");
  assert.deepEqual(command.residual.appMetadata.crossChannelReply,
    { sourceChannelId: "channel-away", sourceMessageId: "reply-9", linkMessageId: "link-1",
      replierKind: "agent", replierAgentId: "agent-7", replierInstanceId: "channel-home:2",
      requesterInstanceId: "channel-home:1" },
    "where it was written lives in metadata, resolved per reader; the replying Instance is skipped live");
  assert.equal(command.body, "yes, v84 is live", "the reply reads as itself, with no relay preamble");
  assert.equal(command.senderSnapshot.label, "claude:2", "the relay shows who answered");
  assert.equal(command.senderSnapshot.avatarUrl, "https://a/claude.png");
  assert.equal(command.senderSnapshot.userId, "owner-1", "under the link owner's identity");
});

test("a relay whose replier is unknown keeps the xMatrix system face", async () => {
  const { crossChannelReplySenderSnapshot } = await import("../src/product-cross-channel-reply.ts");
  assert.equal(crossChannelReplySenderSnapshot("owner-1", undefined).label, "xMatrix");
  const noFace = crossChannelReplySenderSnapshot("owner-1", { kind: "user", label: "Ada" });
  assert.equal(noFace.label, "Ada");
  assert.equal(noFace.avatarUrl, undefined, "never the xMatrix avatar on a person's reply");
});

test("a rejected relay fails loudly instead of pretending the reply arrived", async () => {
  const { relayCrossChannelReply } = await import("../src/product-cross-channel-reply.ts");
  await assert.rejects(relayCrossChannelReply({
    env: {}, channelId: "channel-away", messageId: "reply-9", body: "hi",
    origin: { channelId: "channel-home", messageId: "link-1", ownerUserId: "owner-1" },
  }, {
    append: async () => Response.json({ error: "Channel is archived" }, { status: 409 }),
  }), /rejected \(409\): Channel is archived/u);
});

test("a message the Hub writes itself is delivered live after it commits", async () => {
  const { deliverCommittedProductMessage } = await import("../src/product-message-append.ts");
  const published = [];
  const command = { messageId: "system:1", body: "@codex stopped.", principal: { kind: "user", id: "owner-1" },
    senderSnapshot: { kind: "user", label: "xMatrix", userId: "owner-1" },
    residual: { appMetadata: { xmatrixProvenance: "system_fact" }, replyToMessageId: "m-0" } };
  await deliverCommittedProductMessage({}, "channel-1", command, {
    sequence: 7, committedAt: "2026-09-25T15:00:00.000Z", entityVersion: 1, bodyHash: "b".repeat(64),
  }, async (_env, _waitUntil, channelId, payload) => { published.push({ channelId, payload }); });
  assert.equal(published.length, 1);
  const [{ channelId, payload }] = published;
  assert.equal(channelId, "channel-1");
  assert.equal(payload.messageId, "system:1");
  assert.equal(payload.sequence, 7);
  assert.equal(payload.body, "@codex stopped.");
  assert.equal(payload.from.label, "xMatrix");
  assert.equal(payload.replyToMessageId, "m-0");
  assert.deepEqual(payload.metadata, { xmatrixProvenance: "system_fact" });

  // A failed delivery never fails the append that already committed.
  await deliverCommittedProductMessage({}, "channel-1", command, { sequence: 7 },
    async () => { throw new Error("runtime down"); });
  // Nothing to deliver without a committed sequence.
  let called = false;
  await deliverCommittedProductMessage({}, "channel-1", command, {}, async () => { called = true; });
  assert.equal(called, false);
});

test("xMatrix's own message is committed as system:xmatrix, authorized by the Human principal", async () => {
  const database = agentAppendDatabase({ sequenceChannelId: "channel-1", rows: openAppendRows("channel-1") });
  const append = (extra = {}) => postgresMessageAppend({}, "channel-1", {
    commandId: "command-xmatrix-1", messageId: "xmatrix-summon:first", channelId: "channel-1",
    body: "@codex launch:force", principal: { kind: "user", id: "author" }, xmatrixAuthor: true, ...extra,
  }, { database, spaceId: "space-1", placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 } });
  const result = await append();
  assert.partialDeepStrictEqual(result.senderSnapshot, { identityId: "system:xmatrix", kind: "system", label: "xMatrix" });
  assert.partialDeepStrictEqual(postgresProductMessage({ messageId: "m", channelId: "channel-1", sequence: 2,
    senderKind: "system", senderId: "xmatrix", sentAt: "2026-10-04T00:00:00.000Z", tombstoneSender: undefined }).from,
  { kind: "system", identityId: "xmatrix" });
  await assert.rejects(append({ appAuthorId: "github" }), error => error.code === "invalid_command");
  await assert.rejects(append({ senderId: "someone" }), error => error.code === "invalid_command");
});

test("an imported message keeps its Slack author and time, and mentions nobody", async () => {
  const calls = [];
  const database = agentAppendDatabase({ calls, sequenceChannelId: "channel-1", rows: openAppendRows("channel-1") });
  const author = { source: "slack", id: "U123", name: "Ada Lovelace", email: "ada@example.com",
    avatarUrl: "https://avatars.slack-edge.com/ada.png" };
  const append = (extra = {}) => postgresMessageAppend({}, "channel-1", {
    commandId: "command-slack-1", messageId: "slack-message:job:0:0", channelId: "channel-1",
    body: "@codex /stop all", principal: { kind: "user", id: "importer" },
    sentAt: "2021-03-04T05:06:07.890Z", importedAuthor: author, ...extra,
  }, { database, spaceId: "space-1", placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 } });
  const result = await append();
  assert.partialDeepStrictEqual(result.senderSnapshot, { identityId: "user:slack:U123", kind: "user",
    label: "Ada Lovelace", email: "ada@example.com", avatarUrl: "https://avatars.slack-edge.com/ada.png" });
  assert.equal(result.committedAt, "2021-03-04T05:06:07.890Z");
  assert.equal(result.attentionTargetCount, 0, "history replays what was said elsewhere: it mentions no one");
  assert.ok(calls.filter((query) => /attention|agent_target|stop/u.test(query.name ?? ""))
    .every((query) => !JSON.stringify(query.values ?? []).includes("@codex")));
  await assert.rejects(append({ appAuthorId: "github" }), error => error.code === "invalid_command");
  await assert.rejects(append({ principal: { kind: "agent", id: "agent-1" } }), error => error.code === "invalid_command");
});
