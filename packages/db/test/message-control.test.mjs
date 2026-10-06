import assert from "node:assert/strict";
import test from "node:test";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";

import {
  MessageAuthorityError,
  PostgresMessageRepository,
} from "../dist/message-control.js";
import { registeredRunRows } from "./registered-run.fixture.mjs";
import { activePlacementRow, recordingDatabase as database } from "./recording-database.fixture.mjs";

function preparedMessage(overrides = {}) {
  return {
    codecId: "canonical-clone-cbor-v1",
    payloadSchemaVersion: 1,
    fieldPresenceBase64: "AA",
    payloadBundleBase64: "AA",
    bodyHash: "2".repeat(64),
    senderSnapshotDigest: "3".repeat(64),
    recordDigest: "4".repeat(64),
    recordEncodedBytes: 10,
    preview: { bodyPreview: "hello", senderSnapshot: { kind: "user", label: "User" } },
    ...overrides,
  };
}

function appendRequest(overrides = {}) {
  return {
    ...messageCommandFields(),
    sequence: 1,
    principal: { kind: "user", id: "user-1" },
    senderKind: "user",
    senderId: "user-1",
    messageKind: "xmatrix.message.text",
    sentAt: "2026-08-30T00:00:00.000Z",
    prepared: preparedMessage(),
    senderSnapshot: { userId: "user-1" },
    ...overrides,
  };
}

function appendPreflight(overrides = {}) {
  return {
    command_kind: null,
    request_digest: null,
    result_json: null,
    channel_id: "channel-1",
    channel_mode: "open",
    channel_metadata_json: {},
    channel_authorized: true,
    duplicate_exists: false,
    ...overrides,
  };
}

function appendPublication(overrides = {}) {
  return {
    status: null,
    grace_until: null,
    seat_quantity: null,
    seat_count: null,
    prior_free_message_count: 0,
    free_message_count: 1,
    accepted: true,
    channel_id: "channel-1",
    sequence_confirmed: true,
    ...overrides,
  };
}

/** The fused commit and unmetered publication rows for an accepted append. */
function committedAppend(query, searchRank) {
  if (query.name === "message_append_commit_facts_v5") return [{
    search_rank: searchRank, content_revision: 0, channel_id: "channel-1",
  }];
  if (query.name === "message_append_publish_unmetered_v1") return [appendPublication({
    result_json: JSON.parse(query.values[4]),
  })];
  return undefined;
}

function provenMessageRun(overrides = {}) {
  return {
    owner_user_id: "owner-1",
    channel_id: "channel-1",
    run_status: "running",
    instance_status: "busy",
    instance_channel_id: "channel-1",
    channel_instance_id: "7",
    metadata_json: { executionKey: "execution-1" },
    ...overrides,
  };
}

function mutableMessageRow(overrides = {}) {
  return {
    space_id: "space-1",
    channel_id: "channel-1",
    message_id: "message-1",
    entity_version: 2,
    author_kind: "user",
    author_id: "user-1",
    deleted_at: null,
    ...overrides,
  };
}

function tombstoneRequest(overrides = {}) {
  return {
    ...messageCommandFields(),
    expectedEntityVersion: 1,
    principal: { kind: "user", id: "user-1" },
    kind: "delete",
    redactedContentHash: "2".repeat(64),
    ...overrides,
  };
}

test("append commits structured invocation intent with its source and excludes only its exact span from legacy resolution", async () => {
  const body = "@codex:new:org/repo fix @alice", bodyHash = await digestCanonicalCloneCborV1(body);
  const selection = { start: 0, end: 19, text: "@codex:new:org/repo",
    target: { kind: "capability", harness: "codex" } };
  selection.end = selection.text.length;
  const invocationSelections = { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: bodyHash,
    selections: [selection] };
  const db = database(query => placement(query) ?? appendReservation(query) ?? (
    query.name === "message_append_preflight_v4"
      ? [appendPreflight()]
      : query.name === "registration_authority_active_v1" ? [{ mode: "composite" }]
      : query.name?.startsWith("channel_capability_runtime_")
        ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {}, version: 1, archived_at: null }]
      : query.name === "message_invocation_selection_authorize_v1" ? [{ harness: "codex" }]
      : query.name === "message_attention_candidates_v5" ? [
          { subject_id: "agent:codex-a", name: "codex" }, { subject_id: "agent:codex-b", name: "codex" },
          { subject_id: "user:alice", name: "alice" }]
      : query.name === "message_attention_authorize_v3" ? query.values[2].map(subject_id => ({ subject_id }))
      : query.name === "message_append_commit_facts_v5"
        ? [{ search_rank: "pg:00000000000000000043", content_revision: 0, channel_id: "channel-1" }]
      : query.name === "message_agent_targets_commit_v1" ? [{ message_id: "message-1" }]
      : query.name === "message_append_publish_unmetered_v1"
        ? [{ accepted: true, channel_id: "channel-1", sequence_confirmed: true, result_json: JSON.parse(query.values[4]) }]
      : []));
  const input = appendRequest({
    sentAt: "2026-09-20T00:00:00.000Z",
    prepared: preparedMessage({ bodyHash }),
    attentionBody: body,
    invocationSelections,
  });
  await new PostgresMessageRepository(db).append(input);
  const stored = JSON.parse(db.calls.find(call => call.name === "message_agent_targets_commit_v1").values[3]);
  assert.deepEqual(stored, { entityVersion: 1, bodyHash, targets: [], selections: invocationSelections });
  assert.deepEqual(JSON.parse(db.calls.find(call => call.name === "message_append_attention_batch_v2").values[0]),
    [{ subject_id: "user:alice", kind: "mention" }]);
  await assert.rejects(() => new PostgresMessageRepository(db).append({ ...input,
    invocationSelections: { ...invocationSelections, sourceRevision: 2 } }), error => error.code === "invocation_selection_stale");
});

/** The fused history statement's one metadata row, joined to each page row. */
function historyPage(rows = [], meta = {}) {
  const head = { history_authorized: true, acknowledged_sequence: 0, content_revision: 0,
    history_head_sequence: 0, ...meta };
  const empty = { thread_channel_id: null, thread_updated_at: null, reply_count: null, reply_rows: null };
  return rows.length === 0
    ? [{ ...head, message_id: null, ...empty }]
    : rows.map((row) => ({ ...head, ...empty, ...row }));
}

test("Message history reads the fenced page in one statement of the request session", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_history_page_v3"
      ? historyPage([], { acknowledged_sequence: 4, content_revision: 9, history_head_sequence: 17 })
      : []
  ));

  const result = await new PostgresMessageRepository(db).history({
    requestId: "history-1",
    spaceId: "space-1",
    channelId: "channel-1",
    principal: { kind: "user", id: "user-1" },
  });

  assert.deepEqual(result, {
    messages: [], hasMore: false, principalAckedSequence: 4, contentRevision: 9,
    historyHeadSequence: 17,
  });
  assert.equal(db.sessionOpens, 1);
  assert.equal(db.sessionCloses, 1);
  assert.deepEqual(db.calls.filter((call) => call.name).map((call) => call.name),
    ["space_placement_resolve_v1", "message_history_page_v3"],
    "capability, page, Thread summaries and head counters share one statement");
  const pageContext = db.calls[db.calls.findIndex((call) => call.name === "message_history_page_v3") - 1].context;
  assert.equal(pageContext.statement, "single_read");
  assert.deepEqual(pageContext.placement, { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 },
    "the single read carries the placement it must fence");
  const page = db.calls.find((call) => call.name === "message_history_page_v3");
  assert.match(page.text, /authorized_channel AS MATERIALIZED/u);
  assert.match(page.text, /thread_summaries AS MATERIALIZED/u,
    "each Thread's reply count runs once, not once per history row");
  assert.match(page.text, /SELECT COUNT\(\*\) FROM data\.messages reply/u);
  assert.match(page.text, /WHERE EXISTS \(SELECT 1 FROM authorized_channel\)/u,
    "no row is read before the reader's capability holds");
  assert.match(page.text, /CASE WHEN granted\.authorized THEN/u);
});

test("Message history refuses a reader without the Channel capability and reads nothing further", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_history_page_v3"
      ? [{ history_authorized: false, acknowledged_sequence: null, content_revision: null,
          history_head_sequence: null, message_id: null }]
      : []
  ));
  await assert.rejects(new PostgresMessageRepository(db).history({
    requestId: "history-denied", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "user", id: "stranger" },
  }), (error) => error instanceof MessageAuthorityError && error.code === "channel_not_found");
  assert.deepEqual(db.calls.filter((call) => call.name).map((call) => call.name),
    ["space_placement_resolve_v1", "message_history_page_v3"]);
  const empty = database((query) => placement(query) ?? []);
  await assert.rejects(new PostgresMessageRepository(empty).history({
    requestId: "history-no-row", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "user", id: "stranger" },
  }), (error) => error.code === "channel_not_found", "a missing metadata row fails closed");
});

test("Message history uses a caller-resolved placement only while it is active", async () => {
  const resolvedPlacement = { spaceId: "space-1", shardId: "shard-2", placementEpoch: 5,
    state: "active", targetShardId: null, planClass: "shared" };
  const db = database((query) => query.name === "message_history_page_v3" ? historyPage() : []);
  const input = { requestId: "history-placed", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "user", id: "user-1" }, resolvedPlacement };
  await new PostgresMessageRepository(db).history(input);
  assert.equal(db.calls.some((call) => call.name === "space_placement_resolve_v1"), false);
  assert.deepEqual(db.calls.find((call) => call.context?.placement).context.placement,
    { spaceId: "space-1", shardId: "shard-2", placementEpoch: 5 });
  for (const stale of [{ state: "moving" }, { state: "blocked" }, { spaceId: "space-2" }]) {
    const refused = database(() => assert.fail("no read may start on an unusable placement"));
    await assert.rejects(new PostgresMessageRepository(refused).history({
      ...input, resolvedPlacement: { ...resolvedPlacement, ...stale },
    }), (error) => error.code === "space_placement_unavailable" && error.status === 503);
  }
});

test("Message history accepts the protocol's initial afterSequence zero cursor", async () => {
  const db = historyDatabase();

  await new PostgresMessageRepository(db).history({
    requestId: "history-after-zero",
    spaceId: "space-1",
    channelId: "channel-1",
    principal: { kind: "agent", id: "instance-1" },
    afterSequence: 0,
  });

  const historyQuery = db.calls.find((call) => call.name === "message_history_page_v3");
  assert.deepEqual(historyQuery.values,
    ["space-1", "channel-1", null, 0, null, 51, "agent", "instance-1", 50, "agent:instance-1"]);
  assert.match(historyQuery.text, /ORDER BY timeline_sequence ASC LIMIT \$6/u);
});

test("Message history is a pure read, so an owner-scoped cross-Space read moves none of the owner's state", async () => {
  // docs/cross-space-read-grants.md: a granted Agent reads history as its owner.
  // That is safe only while this read writes nothing a Human's own read would.
  const db = database((query) => placement(query) ?? (
    query.name === "message_history_page_v3"
      ? historyPage([], { acknowledged_sequence: 3, content_revision: 1 })
      : []
  ));

  await new PostgresMessageRepository(db).history({
    requestId: "history-owner-read", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "user", id: "owner-1" },
  });

  const writes = db.calls.filter((call) => /\b(INSERT|UPDATE|DELETE)\b|\bFOR\s+(UPDATE|SHARE|NO KEY)/iu
    .test(call.text ?? ""));
  assert.deepEqual(writes.map((call) => call.name), []);
});

test("Message history applies the protocol's before timestamp bound", async () => {
  const db = historyDatabase();

  await new PostgresMessageRepository(db).history({
    requestId: "history-before-time",
    spaceId: "space-1",
    channelId: "channel-1",
    principal: { kind: "agent", id: "instance-1" },
    before: "2026-09-10T00:00:00.000Z",
  });

  const historyQuery = db.calls.find((call) => call.name === "message_history_page_v3");
  assert.deepEqual(historyQuery.values, [
    "space-1", "channel-1", null, null, "2026-09-10T00:00:00.000Z", 51,
    "agent", "instance-1", 50, "agent:instance-1",
  ]);
  assert.match(historyQuery.text, /sent_at < \$5/u);
});

test("Message history projects an authorized Thread summary without counting its root copy", async () => {
  const row = (overrides = {}) => ({
    message_id: "root-message", channel_id: "channel-1", timeline_sequence: 1,
    entity_version: 1, author_kind: "user", author_id: "user-1", message_kind: "message",
    content_hash: "hash", payload_kind: "inline", payload_ref: "inline", reactions_json: [],
    annotations_json: [], attachments_json: [], sent_at: "2026-09-02T00:00:00.000Z",
    edited_at: null, recalled_at: null, deleted_at: null, updated_at: "2026-09-02T00:00:00.000Z",
    search_rank_sequence: "pg:1", codec_id: null, payload_schema_version: null,
    field_presence_base64: null, payload_bundle_base64: "AA", body_hash: null,
    sender_snapshot_digest: null, record_digest: null, record_encoded_bytes: null,
    ...overrides,
  });
  const db = database((query) => placement(query) ?? (
    query.name === "message_history_page_v3"
      ? historyPage([row({
          attachments_json: [{ id: "image-1", contentHash: "a".repeat(64) }],
          thread_channel_id: "thread-1", thread_updated_at: "2026-09-02T01:00:00.000Z", reply_count: 1,
          reply_rows: [row({ message_id: "reply-1", channel_id: "thread-1", timeline_sequence: 2 })],
        })])
      : query.name === "message_history_attachment_versions_v1"
        ? [{ message_id: "root-message", attachment_id: "image-1", version: 5,
            content_hash: "a".repeat(64) }]
        : []
  ));

  const result = await new PostgresMessageRepository(db).history({
    requestId: "history-thread", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "user", id: "user-1" },
  });

  assert.equal(result.messages[0].threadSummary.channelId, "thread-1");
  assert.equal(result.messages[0].attachments[0].version, 5);
  assert.equal(result.messages[0].threadSummary.replyCount, 1);
  assert.deepEqual(result.messages[0].threadSummary.replies.map((reply) => reply.messageId), ["reply-1"]);
  const page = db.calls.find((call) => call.name === "message_history_page_v3");
  assert.match(page.text, /root_copy_message_id/u);
  assert.match(page.text, /ORDER BY reply.timeline_sequence DESC LIMIT 2/u);
  assert.match(page.text, /jsonb_agg\(to_jsonb\(reply_row\) ORDER BY reply_row.timeline_sequence\)/u);
  assert.match(page.text, /FROM history_page shown\s+ORDER BY shown.timeline_sequence DESC LIMIT \$9/u,
    "summaries cover only the returned page, not its hasMore probe");
  assert.doesNotMatch(page.text, /author_kind NOT IN \('agent','app'\)/u);
  // Only the legacy attachment edge needed a further read; it is fenced like the page.
  assert.deepEqual(db.calls.filter((call) => call.name).map((call) => call.name),
    ["space_placement_resolve_v1", "message_history_page_v3", "message_history_attachment_versions_v1"]);
  const followUp = db.calls[db.calls.findIndex((call) => call.name === "message_history_attachment_versions_v1") - 1];
  assert.equal(followUp.context.statement, "single_read");
  assert.equal(followUp.context.placement.shardId, "shard-0");
});

/** Every mocked Space places on shard-0 and every Run holds its registration binding. */
function placement(query) {
  return query.name === "space_placement_resolve_v1" ? [activePlacementRow()] : registeredRunRows(query);
}

test("HTTP append receipt reads reauthorize before inspecting cached commit evidence", async () => {
  const db = database(query => placement(query) ?? []);
  await assert.rejects(new PostgresMessageRepository(db).httpAppendReceipt({
    requestId: "receipt-denied", spaceId: "space-1", channelId: "channel-1", messageId: "message-1",
    principal: { kind: "user", id: "user-1" },
  }), error => error.code === "channel_not_found");
  assert.equal(db.calls.some(query => query.name === "message_http_append_receipt_v1"), false);
});

test("receipt output is closed and cannot turn wrong-scope or missing evidence into success", async () => {
  const receipt = { spaceId: "space-1", channelId: "channel-1", messageId: "message-1", sequence: 3,
    bodyHash: "a".repeat(64), senderSnapshot: { kind: "user", userId: "user-1", token: "PRIVATE_SENTINEL" },
    body: "PRIVATE_SENTINEL", payloadBundleBase64: "PRIVATE_SENTINEL" };
  const publication = { bodyHash: receipt.bodyHash, sequence: 3, senderKind: "user", senderId: "user-1" };
  let rows = [{ receipt, publication, message_exists: true }];
  const db = database(query => placement(query) ?? (query.name?.startsWith("channel_capability_message_")
    ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
    : query.name === "message_http_append_receipt_v1" ? rows : []));
  const repo = new PostgresMessageRepository(db);
  const input = { requestId: "receipt-safe", spaceId: "space-1", channelId: "channel-1", messageId: "message-1",
    principal: { kind: "user", id: "user-1" } };
  const result = await repo.httpAppendReceipt(input);
  assert.equal(result.status, "committed");
  assert.equal(JSON.stringify(result).includes("PRIVATE_SENTINEL"), false);
  assert.deepEqual(result.sender, { kind: "user", id: "user-1" });
  assert.equal(result.agentSendFingerprint, undefined, "legacy receipts do not invent submission evidence");
  for (const fingerprint of ["b".repeat(64), "PRIVATE_SENTINEL", "b".repeat(65)]) {
    rows = [{ receipt: { ...receipt, agentSendFingerprint: fingerprint }, publication, message_exists: true }];
    const next = await repo.httpAppendReceipt(input);
    assert.equal(next.agentSendFingerprint, fingerprint.length === 64 ? fingerprint : undefined);
    assert.equal(JSON.stringify(next).includes("PRIVATE_SENTINEL"), false);
  }
  for (const field of ["spaceId", "channelId", "messageId"]) {
    rows = [{ receipt: { ...receipt, [field]: "foreign" }, publication, message_exists: false }];
    assert.equal((await repo.httpAppendReceipt(input)).status, "receipt_unavailable");
  }
  rows = [{ receipt: null, message_exists: true }];
  assert.equal((await repo.httpAppendReceipt(input)).status, "receipt_unavailable");
  rows = [{ receipt: { ...receipt, agentSendFingerprint: "b".repeat(64) }, publication: null, message_exists: true }];
  const unavailable = await repo.httpAppendReceipt(input);
  assert.equal(unavailable.status, "receipt_unavailable", "redacted or edited publication cannot expose its original body fingerprint");
  assert.equal(unavailable.agentSendFingerprint, undefined);
  rows = [{ receipt: null, message_exists: false }];
  assert.equal((await repo.httpAppendReceipt(input)).status, "not_found");
  rows = [];
  await assert.rejects(repo.httpAppendReceipt(input), error => error.code === "receipt_unavailable");
  await assert.rejects(repo.httpAppendReceipt({ ...input, messageId: "a".repeat(161) }), error => error.code === "invalid_command");
  await assert.rejects(repo.httpAppendReceipt({ ...input, principal: { kind: "agent", id: "instance-1" } }),
    error => error.code === "agent_run_forbidden");
});
function appendReservation(query) {
  return query.name === "message_sequence_reservation_verify_v1"
    ? [{ channel_id: "channel-1", sequence: 1, state: "reserved", fact_digest: null }]
    : undefined;
}

test("Message sender identity resolves from the exact PostgreSQL Space", async () => {
  const db = database((query) => placement(query) ?? (
    query.name?.startsWith("channel_capability_message_")
      ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
      : query.name === "message_sender_user_identity_v1"
        ? [{ user_id: "user-1", email: "user@example.com", display_name: "User One",
            avatar_url: "https://example.com/avatar.png", version: 7 }]
        : []
  ));
  const identity = await new PostgresMessageRepository(db).senderIdentity({
    requestId: "sender-1", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "user", id: "user-1" },
  });

  assert.deepEqual(identity, {
    kind: "user", id: "user-1", email: "user@example.com", displayName: "User One",
    avatarUrl: "https://example.com/avatar.png", version: 7,
  });
  const query = db.calls.find((call) => call.name === "message_sender_user_identity_v1");
  assert.deepEqual(query.values, ["space-1", "user-1"]);
});

test("Message append preparation combines authorization, sender identity, and observed head", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_prepare_context_v8"
      ? [{ sequence: 41, sender_identity: { kind: "user", id: "user-1", email: null,
          displayName: "User", avatarUrl: null, version: 2 },
          channel_authorized: true }]
          : []
  ));
  const prepared = await new PostgresMessageRepository(db).prepareAppend({
    requestId: "prepare-1", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "user", id: "user-1" },
    senderPrincipal: { kind: "user", id: "user-1" },
    placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 },
  });
  assert.deepEqual(prepared, {
    sequence: 41,
    principal: { kind: "user", id: "user-1" },
    senderIdentity: {
      kind: "user", id: "user-1", email: null, displayName: "User", avatarUrl: null, version: 2,
    },
  });
  const prepareTransactions = db.calls.filter(
    (call) => call.context?.operation === "message.prepare-append",
  );
  assert.equal(prepareTransactions.length, 1, "the request route is reused by one placed prepare transaction");
  assert.equal(db.calls.some((call) => call.name === "message_prepare_context_v8"), true);
  assert.equal(db.calls.filter((call) => call.name?.startsWith("message_prepare_")).length, 1);
});

test("Agent append preparation returns canonical identity from its exact Run proof", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_append_run_proof_v3"
      ? [provenMessageRun()]
      : query.name?.startsWith("channel_capability_message_")
        ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
        : agentPreparationRows(query)
  ));
  const prepared = await new PostgresMessageRepository(db).prepareAppend({
    requestId: "prepare-agent", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "agent", id: "instance-1" },
    senderPrincipal: { kind: "agent", id: "instance-1" },
    runProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" },
  });
  assert.deepEqual(prepared.agentRunIdentity, {
    runId: "run-1", instanceId: "instance-1", channelId: "channel-1", channelInstanceId: 7,
    registration: { ownerUserId: "owner-1", machineId: "machine-1", harness: "codex" },
  });
  assert.equal(prepared.senderIdentity.name, "Codex");
  const proofQuery = db.calls.find((call) => call.name === "message_append_run_proof_v3");
  // A `/kill all` fence waits for this Run until the Agent append commits.
  assert.match(proofQuery.text, /FOR SHARE OF r/u);
  assert.match(proofQuery.text, /i\.channel_instance_id/u);
  assert.deepEqual(proofQuery.values, ["run-1", "instance-1"]);
});

test("Agent append preparation rejects mismatched Run and Instance Channel identity", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_append_run_proof_v3"
      ? [provenMessageRun({instance_status: "online",
instance_channel_id: "channel-2",
channel_instance_id: 7})]
      : []
  ));
  await assert.rejects(new PostgresMessageRepository(db).prepareAppend({
    requestId: "prepare-agent-mismatch", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "agent", id: "instance-1" },
    senderPrincipal: { kind: "agent", id: "instance-1" },
    runProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" },
  }), (error) => error instanceof MessageAuthorityError && error.code === "agent_run_forbidden");
});

test("Message sequence reservation allocates in PostgreSQL and replays by command", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_sequence_reservation_read_v1"
      ? []
      : query.name === "message_sequence_allocate_v1"
        ? [{ allocated_sequence: 42 }]
        : query.name === "message_sequence_reservation_insert_v1"
          ? [{ channel_id: "channel-1", sequence: 42, state: "reserved" }]
          : []
  ));
  const repository = new PostgresMessageRepository(db);
  assert.deepEqual(await repository.reserveAppendSequence({
    requestId: "reserve-1", commandId: "command-1", spaceId: "space-1",
    channelId: "channel-1", observedPostgresHead: 41,
  }), { sequence: 42, state: "reserved" });
  const allocation = db.calls.find((call) => call.name === "message_sequence_allocate_v1");
  assert.match(allocation.text, /ON CONFLICT \(space_id,channel_id\) DO UPDATE/u);
  assert.deepEqual(allocation.values.slice(0, 3), ["space-1", "channel-1", 41]);
});

test("Message sequence reservation returns an existing command without another allocation", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_sequence_reservation_read_v1"
      ? [{ channel_id: "channel-1", sequence: 7, state: "committed" }]
      : []
  ));
  assert.deepEqual(await new PostgresMessageRepository(db).reserveAppendSequence({
    requestId: "reserve-replay", commandId: "command-1", spaceId: "space-1",
    channelId: "channel-1", observedPostgresHead: 9,
  }), { sequence: 7, state: "committed" });
  assert.equal(db.calls.some((call) => call.name === "message_sequence_allocate_v1"), false);
});

test("Message sequence reservation reallocates an uncommitted rollout collision", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_sequence_reservation_read_v1"
      ? [{ channel_id: "channel-1", sequence: 7, state: "reserved" }]
      : query.name === "message_sequence_reservation_collision_v1"
        ? [{ message_id: "message-from-prior-worker" }]
        : query.name === "message_sequence_allocate_v1"
          ? [{ allocated_sequence: 9 }]
          : query.name === "message_sequence_reservation_reallocate_v1"
            ? [{ channel_id: "channel-1", sequence: 9, state: "reserved" }]
            : []
  ));
  assert.deepEqual(await new PostgresMessageRepository(db).reserveAppendSequence({
    requestId: "reserve-collision", commandId: "command-1", spaceId: "space-1",
    channelId: "channel-1", observedPostgresHead: 8,
  }), { sequence: 9, state: "reserved" });
  const reallocation = db.calls.find(
    (call) => call.name === "message_sequence_reservation_reallocate_v1",
  );
  assert.equal(reallocation.values[6], 7);
  assert.match(reallocation.text, /state='reserved'/u);
});

test("Message append reconciliation reads the command idempotency receipt", async () => {
  const result = { messageId: "message-1", sequence: 7 };
  const db = database((query) => placement(query) ?? (
    query.name === "message_append_reconcile_v1"
      ? [{ command_kind: "message-append", request_digest: "1".repeat(64), result_json: result }]
      : []
  ));
  assert.deepEqual(await new PostgresMessageRepository(db).reconcileAppend({
    requestId: "reconcile-1", commandId: "command-1", requestDigest: "1".repeat(64),
    spaceId: "space-1",
  }), result);
});

test("Message live delivery keeps the database row contract at 10000 while detecting overflow", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_live_routing_source_v1"
      ? [{ author_kind: "user", author_id: "user-1", metadata_json: {} }]
      : query.name === "message_live_routing_recipients_v4"
        ? [{ user_id: "user-1", recipient_count: "10001" }]
        : []
  ));

  await assert.rejects(
    new PostgresMessageRepository(db).liveDeliveryRouting({
      requestId: "live-routing-1",
      spaceId: "space-1",
      channelId: "channel-1",
      messageId: "message-1",
    }),
    (error) => error instanceof MessageAuthorityError &&
      error.code === "live_recipient_limit_exceeded",
  );
  const query = db.calls.find((call) => call.name === "message_live_routing_recipients_v4");
  assert.equal(query.maxRows, 10_000);
  assert.match(query.text, /COUNT\(\*\) OVER \(\) AS recipient_count/u);
  assert.match(query.text, /LIMIT 10000/u);
});

test("Message live delivery carries the mentioned Human's unread attention summary", async () => {
  const db = database((query) => placement(query) ?? (
    query.name === "message_live_routing_source_v1"
      ? [{ author_kind: "agent", author_id: "instance-1", metadata_json: {} }]
      : query.name === "message_live_routing_recipients_v4"
        ? [{ user_id: "user-1", recipient_count: "2" }, { user_id: "user-2", recipient_count: "2" }]
        : query.name === "message_live_routing_attention_v1"
          ? [{ subject_id: "user:user-2", kind: "mention" }]
          : query.name === "message_live_routing_attention_summary_v1"
            ? [{ subject_id: "user:user-2", unread_count: "2", message_id: "message-1", kind: "mention",
              timeline_sequence: "9", created_at: new Date("2026-09-26T00:00:00.000Z"), kinds: ["mention", "reply"] }]
            : []
  ));
  const routing = await new PostgresMessageRepository(db).liveDeliveryRouting({
    requestId: "live-routing-2", spaceId: "space-1", channelId: "channel-1", messageId: "message-1",
  });
  assert.deepEqual(routing.recipientNotifications, [{ userId: "user-2", notification: { reason: "mention",
    attention: { channelId: "channel-1", unreadAttentionCount: 2, lastAttentionAt: "2026-09-26T00:00:00.000Z",
      lastMessageId: "message-1", lastMessageSequence: 9, primaryTriggerKind: "mention",
      triggerKinds: ["mention", "reply"], updatedAt: "2026-09-26T00:00:00.000Z" } } }]);
  const summary = db.calls.find((call) => call.name === "message_live_routing_attention_summary_v1");
  assert.deepEqual(summary.values[2], ["user:user-2"]);
  assert.match(summary.text, /delivery_cursors/u);
});

test("Message acknowledge serializes an exact command before its idempotency read", async () => {
  const db = database((query) => placement(query) ?? (
    query.name?.startsWith("channel_capability_message_")
      ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
      : query.name === "message_ack_idempotency_read_v1"
        ? []
        : query.name === "message_ack_head_v1"
          ? [{ sequence: 7 }]
          : query.name === "message_ack_cursor_lock_v1"
            ? [{
                acknowledged_sequence: 6,
                version: 2,
                updated_at: "2026-09-04T00:00:00.000Z",
              }]
            : []
  ));

  const result = await new PostgresMessageRepository(db).acknowledge({
    requestId: "ack-1",
    commandId: "command-1",
    requestDigest: "1".repeat(64),
    spaceId: "space-1",
    channelId: "channel-1",
    principal: { kind: "user", id: "user-1" },
    sequence: 7,
  });

  assert.equal(result.ackedSequence, 7);
  const lockIndex = db.calls.findIndex((call) => call.name === "message_ack_idempotency_lock_v1");
  const readIndex = db.calls.findIndex((call) => call.name === "message_ack_idempotency_read_v1");
  assert.ok(lockIndex >= 0 && lockIndex < readIndex);
  const lock = db.calls[lockIndex];
  assert.deepEqual(lock.values, ["space-1", "command-1"]);
  assert.equal(lock.maxRows, 1);
  assert.match(lock.text, /pg_advisory_xact_lock/u);
  assert.match(lock.text, /message-ack:/u);
});

test("Message append reauthorizes and commits every relational fact with one outbox", async () => {
  const db = database((query) => placement(query) ?? appendReservation(query) ?? (
    query.name === "message_append_preflight_v4"
      ? [appendPreflight()]
      : (committedAppend(query, "pg:00000000000000000042") ?? (query.name === "message_attention_authorize_v3"
        ? [{ subject_id: "user:user-2" }]
        : []))
  ));
  const result = await new PostgresMessageRepository(db).append(appendRequest({
    attentionTargets: [{ subjectId: "user:user-2", kind: "mention" }],
    placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 },
  }));

  assert.equal(result.messageId, "message-1");
  assert.equal(result.searchRankSeq, "pg:00000000000000000042");
  const appendAuthorization = db.calls.find((call) => call.name === "message_append_preflight_v4");
  assert.doesNotMatch(appendAuthorization.text, /FOR UPDATE/u);
  for (const queryName of [
    "message_append_preflight_v4",
    "message_append_commit_facts_v5",
    "message_append_attention_batch_v2",
    "message_append_publish_unmetered_v1",
  ]) assert.equal(db.calls.some((call) => call.name === queryName), true, queryName);
  const billingAdvance = db.calls.find(
    (call) => call.name === "message_append_publish_unmetered_v1",
  );
  assert.doesNotMatch(billingAdvance.text, /space_billing_/u,
    "the default deployment meters nothing, so publishing reads no billing table");
  assert.match(billingAdvance.text, /INSERT INTO data\.outbox/u);
  assert.match(billingAdvance.text, /INSERT INTO data\.idempotency_keys/u);
  assert.match(
    billingAdvance.text,
    /updated_at=GREATEST\(updated_at,\$6::timestamptz\)/u,
    "a client message timestamp older than reservation creation cannot move updated_at backwards",
  );
  const committedFacts = db.calls.find((call) => call.name === "message_append_commit_facts_v5");
  assert.deepEqual(JSON.parse(committedFacts.values[24]),
    { bodyPreview: "hello", senderSnapshot: { kind: "user", label: "User" } },
    "the preview is written with the payload it was derived from");
  assert.doesNotMatch(committedFacts.text, /UPDATE data\.channels/u);
  assert.match(billingAdvance.text, /UPDATE data\.channels/u);
  assert.doesNotMatch(billingAdvance.text, /archived_at IS NULL/u,
    "the shared locked capability gate is the only lifecycle admission decision");
  assert.match(billingAdvance.text, /RETURNING channel_id/u);
  assert.equal(db.calls.indexOf(billingAdvance) > db.calls.findIndex(
    (call) => call.name === "message_append_commit_facts_v5",
  ), true, "billing admission must remain at the short transaction tail");
  assert.equal(db.calls.some((call) => call.name === "space_placement_resolve_v1"), false);
});

test("a Human stop command fences its Runs before the message's first write", async () => {
  const append = async (input) => {
    const db = database((query) => placement(query) ?? appendReservation(query) ?? (
      query.name === "message_append_preflight_v4"
        ? [appendPreflight()]
        : (committedAppend(query, "pg:00000000000000000042") ?? (query.name === "channel_stop_fence_v2"
          ? [{ run_id: "run-1", version: 2, instance_id: "instance-1" }]
        : query.name === "message_agent_target_resolve_v5"
          ? JSON.parse(query.values[2]).filter((request) => request.address === "@codex:1")
            .map((request) => ({ address: request.address, instance_id: "instance-1", run_id: "run-1" }))
        : query.name === "runtime_control_head_advance_v1"
          ? [{ commit_sequence: 9 }]
          : []))
    ));
    const result = await new PostgresMessageRepository(db).append(appendRequest({
      sentAt: "2026-09-26T09:00:00.000Z",
      placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 },
      ...input,
    }));
    return { db, result };
  };

  const { db, result } = await append({ attentionBody: "/kill all" });
  assert.equal(result.messageId, "message-1");
  const fence = db.calls.findIndex((call) => call.name === "channel_stop_fence_v2");
  assert.ok(fence >= 0);
  assert.deepEqual([...db.calls[fence].values.slice(0, 3), ...db.calls[fence].values.slice(4)],
    ["space-1", "channel-1", "user-1", null, false]);
  assert.ok(fence < db.calls.findIndex((call) => call.name === "message_append_commit_facts_v5"),
    "Run locks precede the append's writes, so an Agent append holding its Run cannot deadlock it");
  assert.ok(db.calls.some((call) => call.name === "runtime_outbox_v1"));

  // An exact address fences only the Run its message resolves to.
  for (const attentionBody of ["@codex:1:stop", "/stop codex:1 wrong branch"]) {
    const exact = await append({ attentionBody });
    const call = exact.db.calls.find((query) => query.name === "channel_stop_fence_v2");
    assert.deepEqual(call?.values.slice(4), ["run-1", false], attentionBody);
  }
  const management = (await append({ attentionBody: "@xMatrix:stop" })).db.calls
    .find((query) => query.name === "channel_stop_fence_v2");
  assert.deepEqual(management?.values.slice(4), [null, true]);

  for (const attentionBody of ["please /kill all", "`/kill all`", "@codex:2:stop", "@codex:stop", "hello", undefined]) {
    const ordinary = await append(attentionBody === undefined ? {} : { attentionBody });
    assert.equal(ordinary.db.calls.some((call) => call.name === "channel_stop_fence_v2"), false,
      String(attentionBody));
  }
});

test("an Agent's stop command fences as its Run's owner before the message's first write", async () => {
  const append = async (attentionBody) => {
    const db = database((query) => placement(query) ?? appendReservation(query) ?? (
      query.name === "message_append_run_proof_v3"
        ? [provenMessageRun({owner_user_id: "user-owner",
instance_status: "online",
channel_instance_id: 1})]
        : query.name?.startsWith("channel_capability_message_")
          ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
          : (committedAppend(query, "pg:00000000000000000044") ?? (query.name === "channel_stop_fence_v2"
          ? [{ run_id: "run-2", version: 2, instance_id: "instance-2" }]
        : query.name === "runtime_control_head_advance_v1"
          ? [{ commit_sequence: 9 }]
          : []))
    ));
    await new PostgresMessageRepository(db).append(appendRequest({
      requestId: "request-agent-stop",
      commandId: "command-agent-stop",
      messageId: "message-agent-stop",
      principal: { kind: "agent", id: "instance-1" },
      senderKind: "agent",
      senderId: "instance-1",
      sentAt: "2026-09-29T14:31:18.000Z",
      senderSnapshot: { agentId: "instance-1" },
      runProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" },
      ...(attentionBody === undefined ? {} : { attentionBody }),
    }));
    return db;
  };

  const db = await append("/stop all verification");
  const fence = db.calls.findIndex((call) => call.name === "channel_stop_fence_v2");
  assert.ok(fence >= 0, "an Agent's stop takes effect when its message commits");
  assert.deepEqual(db.calls[fence].values.slice(0, 3), ["space-1", "channel-1", "user-owner"],
    "the stop acts with the Run owner's authority, never the Agent's");
  assert.ok(fence < db.calls.findIndex((call) => call.name === "message_append_commit_facts_v5"));
  for (const body of ["hello", "please /stop all", undefined]) {
    assert.equal((await append(body)).calls.some((call) => call.name === "channel_stop_fence_v2"), false,
      String(body));
  }
});

test("Message append writes zero, one, or ten attachments with at most one SQL call", async () => {
  const appendInput = (count) => (appendRequest({
    requestId: `request-${count}`,
    commandId: `command-${count}`,
    messageId: `message-${count}`,
    attachmentOwnerUserId: "user-1",
    attachments: Array.from({ length: count }, (_, index) => ({
      id: `attachment-${index}`, objectKey: `objects/${index}`,
      contentHash: String(index % 10).repeat(64), size: index + 1,
      mimeType: "text/plain", name: `file-${index}.txt`, width: index + 10,
    })),
  }));
  for (const count of [0, 1, 10]) {
    const db = database((query) => placement(query) ?? appendReservation(query) ?? (
      query.name === "message_append_preflight_v4"
        ? [appendPreflight()]
        : (committedAppend(query, "pg:00000000000000000042") ?? ([]))
    ));
    await new PostgresMessageRepository(db).append(appendInput(count));
    const writes = db.calls.filter((call) => call.name === "message_append_attachment_batch_v2");
    assert.equal(writes.length, count === 0 ? 0 : 1);
    if (count > 0) {
      assert.equal(JSON.parse(writes[0].values[0]).length, count);
      assert.equal(JSON.parse(writes[0].values[0])[0].presentation_residual_json.width, 10);
      assert.match(writes[0].text, /jsonb_to_recordset/u);
    }
  }
  const overLimitDb = database(() => []);
  await assert.rejects(
    new PostgresMessageRepository(overLimitDb).append(appendInput(11)),
    (error) => error instanceof MessageAuthorityError && error.code === "invalid_command",
  );
  assert.equal(overLimitDb.calls.length, 0);
});

for (const [body, ambiguous, broadcast] of [
  ["＠王力 Hu please review", false, false],
  ["@alice please review", false, false],
  ["@Duplicate please review", true, false],
  ["@alice with @everyone", false, true],
]) test(`PostgreSQL attention resolves display names safely: ${body}`, async () => {
  const db = database((query) => placement(query) ?? appendReservation(query) ?? (
    query.name === "message_append_run_proof_v3"
      ? [agentRunProofRow()]
      : query.name?.startsWith("channel_capability_message_")
        ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
      : query.name === "message_attention_candidates_v5"
        ? [
            { subject_id: "agent:instance-1", name: "Manager" },
            { subject_id: "user:user-2", name: "王力 Hu", handle: "alice" },
            { subject_id: "user:user-3", name: "Duplicate" },
            { subject_id: "user:user-4", name: "Duplicate" },
          ]
      : query.name === "message_attention_authorize_v3"
        ? query.values[2].map(subject_id => ({ subject_id }))
              : (committedAppend(query, "pg:00000000000000000043") ?? ([]))
  ));
  const request = appendRequest(agentAppendFields({ attentionBody: body }));
  const append = () => new PostgresMessageRepository(db).append(request);

  if (ambiguous) {
    await assert.rejects(append(), (error) => error.code === "attention_target_ambiguous");
    assert.equal(db.calls.some((call) => call.name === "message_append_commit_facts_v5"), false);
    return;
  }
  await append();

  const attentionWrite = db.calls.find((call) => call.name === "message_append_attention_batch_v2");
  assert.deepEqual(JSON.parse(attentionWrite.values[0]), broadcast ? [
    { subject_id: "user:user-2", kind: "broadcast" },
    { subject_id: "user:user-3", kind: "broadcast" },
    { subject_id: "user:user-4", kind: "broadcast" },
  ] : [{ subject_id: "user:user-2", kind: "mention" }]);
  const attentionCandidates = db.calls.find(
    (call) => call.name === "message_attention_candidates_v5",
  );
  assert.equal(attentionCandidates.maxRows, 10_000);
  assert.match(attentionCandidates.text, /LEFT JOIN control.auth_users h ON h.id=m.user_id/u);
  assert.match(attentionCandidates.text, /COUNT\(\*\) OVER \(\) AS total_count/u);
  assert.match(attentionCandidates.text, /LIMIT 10000/u);
  const mutation = db.calls.find((call) => call.name === "message_append_commit_facts_v5");
  assert.deepEqual(mutation.values.slice(18, 20), ["agent", "instance-1"]);
  assert.equal(db.calls.some((call) => call.name === "message_attention_authorize_v3"), true);
  await new PostgresMessageRepository(db).append({ ...request, commandId: "command-literal-attention",
    messageId: "message-literal-attention", attentionBody: "`@everyone`\n\n> @everyone\n\n@alice inspect" });
  const literalWrite = db.calls.filter(call => call.name === "message_append_attention_batch_v2").at(-1);
  assert.deepEqual(JSON.parse(literalWrite.values[0]), [{ subject_id: "user:user-2", kind: "mention" }]);

});

test("PostgreSQL append rejects an over-limit attention directory within the query row cap", async () => {
  const db = database((query) => placement(query) ?? appendReservation(query) ?? (
    query.name === "message_append_preflight_v4"
      ? [appendPreflight()]
      : query.name === "message_attention_candidates_v5"
        ? [{ subject_id: "user:user-2", name: "alice", total_count: "10001" }]
        : []
  ));
  await assert.rejects(new PostgresMessageRepository(db).append(appendRequest({
    requestId: "request-attention-limit",
    commandId: "command-attention-limit",
    messageId: "message-attention-limit",
    attentionBody: "@alice",
  })), (error) => error instanceof MessageAuthorityError &&
    error.code === "attention_candidate_limit_exceeded");
  const candidates = db.calls.find((call) => call.name === "message_attention_candidates_v5");
  assert.equal(candidates.maxRows, 10_000);
  assert.equal(db.calls.some((call) => call.name === "message_append_commit_facts_v5"), false);
});

test("Message mutation rejects a lost entity CAS before any fact update", async () => {
  const db = database((query) => placement(query) ?? (
    query.name?.startsWith("channel_capability_message_")
      ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
      : query.name === "message_mutation_candidate_lock_v1"
        ? [mutableMessageRow()]
        : []
  ));
  await assert.rejects(new PostgresMessageRepository(db).tombstone(tombstoneRequest()), (error) => error instanceof MessageAuthorityError && error.code === "message_version_conflict");
  assert.equal(db.calls.some((call) => call.name === "message_delete_update_v1"), false);
});

test("Message tombstone binds the redaction scope inside its transaction", async () => {
  const db = database((query) => placement(query) ?? (
    query.name?.startsWith("channel_capability_message_")
      ? [{ channel_id: "channel-1", space_id: "space-1", mode: "closed", metadata_json: {} }]
      : query.name === "message_mutation_candidate_lock_v1"
        ? [mutableMessageRow({timeline_sequence: 8,
entity_version: 1})]
        : query.name === "message_delete_update_v1" ? [{ message_id: "message-1" }] : []
  ));
  const result = await new PostgresMessageRepository(db).tombstone(tombstoneRequest({requestId: "request-delete",
commandId: "command-delete"}));

  assert.equal(result.spaceId, "space-1");
  assert.equal(result.visibilityScopeId, "channel:channel-1");
  const tombstone = db.calls.find((call) => call.name === "message_delete_update_v1");
  assert.match(tombstone.text, /payload_ref = \$8/u);
  assert.equal(tombstone.values[7], `redacted:${"2".repeat(64)}`);
  const outbox = db.calls.find((call) => call.name === "message_mutation_outbox_v1");
  assert.match(String(outbox.values[6]), /channel:channel-1/u);
});

test("Message reads hide the nonempty PostgreSQL redaction sentinel", async () => {
  const db = database((query) => placement(query) ?? (
    query.name?.startsWith("channel_capability_message_")
      ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
      : query.name === "message_mutation_candidate_read_v1"
        ? [mutableMessageRow({timeline_sequence: 1,
message_kind: "xmatrix.message.text",
content_hash: "2".repeat(64),
payload_kind: "redacted",
payload_ref: `redacted:${"2".repeat(64)}`,
reactions_json: [],
annotations_json: [],
attachments_json: [],
sent_at: "2026-08-30T00:00:00.000Z",
edited_at: null,
recalled_at: null,
updated_at: "2026-08-30T00:00:01.000Z",
search_rank_sequence: "postgres:1",
codec_id: null,
payload_schema_version: null,
field_presence_base64: null,
payload_bundle_base64: null,
body_hash: null,
sender_snapshot_digest: null,
record_digest: null,
record_encoded_bytes: null})]
        : []
  ));

  const message = await new PostgresMessageRepository(db).mutationCandidate({
    requestId: "request-redacted", spaceId: "space-1", channelId: "channel-1",
    messageId: "message-1", principal: { kind: "user", id: "user-1" },
  });

  assert.equal(message.payloadKind, "redacted");
  assert.equal(message.payloadRef, "");
});

function cursorDatabase({ target = 4, authorized = true, replay } = {}) {
  return database((query) => placement(query) ?? (
    query.name?.startsWith("channel_capability_message_")
      ? authorized ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }] : []
      : query.name === "message_ack_idempotency_read_v1"
        ? replay ? [replay] : []
        : query.name === "message_ack_head_v1"
          ? [{ sequence: 9 }]
          : query.name === "message_ack_target_v1"
            ? target === null ? [] : [{ sequence: target }]
            : []
  ));
}

const cursorInput = {
  requestId: "cursor-1", commandId: "cursor-command-1", requestDigest: "2".repeat(64),
  spaceId: "space-1", channelId: "channel-1", principal: { kind: "agent", id: "instance-1" },
  messageId: "summon-message",
};

test("Message-id ACK parks at the addressed message without consuming newer messages", async () => {
  const db = cursorDatabase();
  const result = await new PostgresMessageRepository(db).acknowledge(cursorInput);
  assert.equal(result.ackedSequence, 4);
  assert.equal(result.committedSequence, 9);
  const target = db.calls.find((call) => call.name === "message_ack_target_v1");
  assert.deepEqual(target.values, ["space-1", "channel-1", "summon-message"]);
  assert.match(target.text, /space_id = \$1 AND channel_id = \$2 AND message_id = \$3/u);
  const write = db.calls.find((call) => call.name === "message_ack_cursor_write_v1");
  assert.equal(write.values[1], "agent:instance-1");
  assert.equal(write.values[3], 4);
});

test("Message-id ACK rejects an absent target and conflicting coordinates before writing", async () => {
  for (const [target, extra, code] of [
    [null, {}, "message_not_found"], [4, { sequence: 5 }, "invalid_command"],
  ]) {
    const db = cursorDatabase({ target });
    await assert.rejects(new PostgresMessageRepository(db).acknowledge({ ...cursorInput, ...extra }),
      (error) => error.code === code);
    assert.equal(db.calls.some((call) => call.name === "message_ack_cursor_write_v1"), false);
  }
});

test("Message-id ACK retains authorization and replays without resolving the target again", async () => {
  const denied = cursorDatabase({ authorized: false });
  await assert.rejects(new PostgresMessageRepository(denied).acknowledge(cursorInput));
  assert.equal(denied.calls.some((call) => call.name === "message_ack_target_v1"), false);
  const result = { ackedSequence: 4 };
  const db = cursorDatabase({ replay: {
    command_kind: "message-acknowledge", request_digest: cursorInput.requestDigest, result_json: result,
  } });
  assert.deepEqual(await new PostgresMessageRepository(db).acknowledge(cursorInput), result);
  assert.equal(db.calls.some((call) => call.name === "message_ack_target_v1"), false);
});

test("Agent reply authority survives transport loss but preserves lifecycle and identity fences", async () => {
  let overrides = {};
  const db = database(query => placement(query) ?? (
    query.name === "message_append_run_proof_v3" ? [provenMessageRun({instance_status: "offline",
channel_instance_id: 7,
...overrides})] : query.name?.startsWith("channel_capability_message_")
      ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {} }]
      : agentPreparationRows(query)));
  const repo = new PostgresMessageRepository(db);
  const input = { requestId: "reply-during-disconnect", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "agent", id: "instance-1" }, senderPrincipal: { kind: "agent", id: "instance-1" },
    runProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" } };
  await repo.prepareAppend(input);
  for (const forbidden of [
    { run_status: "stopping" }, { run_status: "stopped" }, { run_status: "completed" },
    { instance_channel_id: "other-channel" },
    { metadata_json: { executionKey: "other-execution" } },
    { metadata_json: { executionKey: "execution-1", instanceDeletion: { state: "pending" } } },
    { metadata_json: { executionKey: "execution-1", instanceHandoff: { schemaVersion: 1 } } },
  ]) {
    overrides = forbidden;
    await assert.rejects(repo.prepareAppend(input), error => error.code === "agent_run_forbidden");
  }
});

function crossChannelRunDatabase({ handling } = { handling: "source-1" }) {
  return database((query) => placement(query) ?? (
    query.name === "message_append_run_proof_v3"
      ? [provenMessageRun()]
      : query.name === "agent_channel_registered_run_access_v2"
        ? [{ owner_user_id: "owner-1", channel_id: "channel-1", status: "running",
            metadata_json: { executionKey: "execution-1" }, instance_channel_id: "channel-1" }]
      : query.name?.startsWith("channel_capability_")
        ? [{ channel_id: query.values?.[1] ?? "channel-2", space_id: "space-1", mode: "open",
            metadata_json: {}, version: 1, archived_at: null }]
      : query.name === "message_append_run_origin_v1"
        ? handling ? [{ source_message_id: handling }] : []
      : agentPreparationRows(query)
  ));
}

test("a cross-Channel Agent write names the Run's own Channel and the message it was handling", async () => {
  const db = crossChannelRunDatabase();
  const prepared = await new PostgresMessageRepository(db).prepareAppend({
    requestId: "prepare-link", spaceId: "space-1", channelId: "channel-2",
    principal: { kind: "agent", id: "instance-1" }, senderPrincipal: { kind: "agent", id: "instance-1" },
    runProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" },
  });
  assert.deepEqual(prepared.agentRunIdentity.origin,
    { channelId: "channel-1", runId: "run-1", messageId: "source-1" });
  const origin = db.calls.find((call) => call.name === "message_append_run_origin_v1");
  assert.deepEqual(origin.values, ["run-1", "channel-1"],
    "the handled message is read from the Run's own executions in its own Channel");
});

test("a cross-Channel write between turns names only the Run's Channel", async () => {
  const prepared = await new PostgresMessageRepository(crossChannelRunDatabase({ handling: null }))
    .prepareAppend({
      requestId: "prepare-link-idle", spaceId: "space-1", channelId: "channel-2",
      principal: { kind: "agent", id: "instance-1" }, senderPrincipal: { kind: "agent", id: "instance-1" },
      runProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" },
    });
  assert.deepEqual(prepared.agentRunIdentity.origin, { channelId: "channel-1", runId: "run-1" });
});

test("an Agent write in its own Channel has no origin and reads no executions", async () => {
  const db = crossChannelRunDatabase();
  const prepared = await new PostgresMessageRepository(db).prepareAppend({
    requestId: "prepare-home", spaceId: "space-1", channelId: "channel-1",
    principal: { kind: "agent", id: "instance-1" }, senderPrincipal: { kind: "agent", id: "instance-1" },
    runProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" },
  });
  assert.equal(prepared.agentRunIdentity.origin, undefined);
  assert.equal(db.calls.some((call) => call.name === "message_append_run_origin_v1"), false);
});

async function appendReplyTo(replyTarget, senderSnapshot =
  { userId: "user-1", kind: "user", label: "Ada", avatarUrl: "https://a/ada.png" }) {
  const body = "sounds good", bodyHash = await digestCanonicalCloneCborV1(body);
  const db = database(query => placement(query) ?? appendReservation(query) ?? (
    query.name === "message_append_preflight_v4"
      ? [appendPreflight()]
      : query.name?.startsWith("channel_capability_runtime_")
        ? [{ channel_id: "channel-1", space_id: "space-1", mode: "open", metadata_json: {}, version: 1, archived_at: null }]
      : query.name === "message_append_reply_target_v3" ? [replyTarget]
      : query.name === "message_attention_authorize_v3" ? query.values[2].map(subject_id => ({ subject_id }))
      : query.name === "message_append_commit_facts_v5"
        ? [{ search_rank: "pg:00000000000000000043", content_revision: 0, channel_id: "channel-1" }]
      : query.name === "message_append_publish_unmetered_v1"
        ? [{ accepted: true, channel_id: "channel-1", sequence_confirmed: true, result_json: JSON.parse(query.values[4]) }]
      : []));
  const result = await new PostgresMessageRepository(db).append(appendRequest({
    requestId: "request-reply",
    commandId: "command-reply",
    messageId: "reply-1",
    sentAt: "2026-09-25T00:00:00.000Z",
    prepared: preparedMessage({ bodyHash }),
    senderSnapshot,
    attentionBody: body,
    replyToMessageId: "link-1",
  }));
  return { db, result };
}

test("a reply to a cross-Channel link returns where to relay it, under the link Run owner's authority", async () => {
  const { db, result } = await appendReplyTo({ author_kind: "agent", author_id: "instance-1",
    origin_channel_id: "channel-origin", origin_owner_user_id: "owner-1",
    origin_instance_id: "channel-origin:3" });
  assert.deepEqual(result.replyOrigin,
    { channelId: "channel-origin", messageId: "link-1", ownerUserId: "owner-1",
      requesterInstanceId: "channel-origin:3",
      replier: { kind: "user", label: "Ada", avatarUrl: "https://a/ada.png" } },
    "the relay shows who answered, taken from the reply's own committed snapshot");
  const target = db.calls.find(call => call.name === "message_append_reply_target_v3");
  assert.match(target.text, /LEFT JOIN data\.runs r ON r\.run_id = m\.origin_run_id/u);
  assert.match(target.text, /split_part\(m\.origin_run_id, '#', 1\)/u,
    "the link's Run names the Instance that asked, the only one the answer is work for");
  const insert = db.calls.find(call => call.name === "message_append_commit_facts_v5");
  assert.deepEqual(insert.values.slice(21, 24), [null, null, null], "a Human reply is never itself a link");
});

test("an Agent's reply to a link names its exact Instance so the relay can skip it", async () => {
  const { result } = await appendReplyTo({ author_kind: "agent", author_id: "instance-1",
    origin_channel_id: "channel-origin", origin_owner_user_id: "owner-1" },
  { kind: "agent", agentId: "agent-7", instanceId: "channel-origin:2", label: "claude:2", userId: "owner-1" });
  assert.deepEqual(result.replyOrigin.replier,
    { kind: "agent", label: "claude:2", agentId: "agent-7", instanceId: "channel-origin:2" });
});

test("a reply to an ordinary message, or to a link whose Run is gone, relays nothing", async () => {
  for (const target of [
    { author_kind: "agent", author_id: "instance-1", origin_channel_id: null, origin_owner_user_id: null },
    { author_kind: "agent", author_id: "instance-1", origin_channel_id: "channel-origin", origin_owner_user_id: null },
    { author_kind: "agent", author_id: "instance-1", origin_channel_id: "channel-1", origin_owner_user_id: "owner-1" },
  ]) {
    const { result } = await appendReplyTo(target);
    assert.equal(result.replyOrigin, undefined);
  }
});

function agentRunProofRow(overrides = {}) {
  return { owner_user_id: "user-owner", channel_id: "channel-1", run_status: "running", instance_status: "online",
    instance_channel_id: "channel-1", channel_instance_id: 1, metadata_json: { executionKey: "execution-1" }, ...overrides };
}

function agentSenderRow(overrides = {}) {
  return { instance_id: "instance-1", name: "Codex", runtime: "codex", owner_user_id: "owner-1", owner_email: "owner@example.test", metadata_json: {}, version: 3, ...overrides };
}

function agentPreparationRows(query) {
  if (query.name === "message_sender_agent_identity_v3") return [agentSenderRow()];
  if (query.name === "message_prepare_observed_head_v1") return [{ sequence: 9 }];
  return [];
}

function agentAppendFields(overrides = {}) {
  return { requestId: "request-agent", commandId: "command-agent", messageId: "message-agent", principal: { kind: "agent", id: "instance-1" }, senderKind: "agent", senderId: "instance-1", senderSnapshot: { agentId: "instance-1" }, runProof: { runId: "run-1", executionKey: "execution-1", instanceId: "instance-1" }, ...overrides };
}

function messageCommandFields() {
  return { requestId: "request-1", commandId: "command-1", requestDigest: "1".repeat(64),
    spaceId: "space-1", channelId: "channel-1", messageId: "message-1" };
}

function historyDatabase() {
  return database(query => placement(query) ?? (query.name === "message_history_page_v3" ? historyPage() : []));
}
