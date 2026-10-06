import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresMessageRepository,
} from "../dist/message-control.js";
import { openMessageChannel, recordingDatabase, storedMessageRow } from "./recording-database.fixture.mjs";

const archivedAt = "2026-09-13T00:00:00.000Z";
const principal = { kind: "user", id: "user-1" };
const scope = {
  requestId: "archived-test", spaceId: "space-1", channelId: "channel-1", principal,
};

function database(respond = () => []) {
  return recordingDatabase((query) => openMessageChannel(query, archivedAt) ?? respond(query));
}

function messageRow(overrides = {}) {
  return storedMessageRow(archivedAt, { author_kind: "agent", author_id: "agent-1", ...overrides });
}

test("archived Channels retain history, annotations, attachments, and viewer ACK", async () => {
  const hash = "a".repeat(64);
  const db = database((query) => {
    // Archive does not narrow the read capability the fused history page checks.
    if (query.name === "message_history_page_v3") {
      assert.doesNotMatch(query.text, /archived_at/u);
      return [{ history_authorized: true, acknowledged_sequence: 0, content_revision: 1,
        history_head_sequence: 0, message_id: null }];
    }
    if (query.name === "message_ack_idempotency_read_v1") return [];
    if (query.name === "message_ack_head_v1") return [{ sequence: 0 }];
    if (query.name === "message_ack_cursor_lock_v1") return [];
    if (query.name === "message_attachment_authority_v1") return [{
      source_channel_id: "channel-1", source_mode: "open", object_key: `objects/${hash}`,
      content_hash: hash, encoded_bytes: 12, mime_type: "text/plain", name: "note.txt",
      presentation_residual_json: null, version: 1,
    }];
    return [];
  });
  const repository = new PostgresMessageRepository(db);

  assert.deepEqual((await repository.history(scope)).messages, []);
  assert.deepEqual(await repository.listAnnotations(scope), { annotations: [], cursor: null });
  assert.equal((await repository.attachmentAuthority({
    ...scope, messageId: "message-1", attachmentId: "attachment-1",
  })).object.contentHash, hash);
  assert.equal((await repository.acknowledge({
    ...scope, commandId: "ack-1", requestDigest: "5".repeat(64), sequence: 0,
  })).ackedSequence, 0);
});

test("archived Channels allow bounded sender snapshot inspection and repair", async () => {
  const prior = messageRow();
  const db = database((query) => {
    if (query.name === "message_sender_repair_candidate_v1" ||
        query.name === "message_sender_repair_lock_v1") return [prior];
    if (query.name === "message_sender_repair_update_v1") return [{ message_id: "message-1" }];
    return [];
  });
  const repository = new PostgresMessageRepository(db);
  assert.equal((await repository.senderRepairCandidate({
    ...scope, messageId: "message-1",
  })).messageId, "message-1");

  const result = await repository.repairSenderSnapshots({
    ...scope, commandId: "repair-1", requestDigest: "6".repeat(64), agentId: "agent-1",
    repairedAt: "2026-09-13T01:00:00.000Z",
    repairs: [{
      messageId: "message-1", expectedEntityVersion: 1,
      expectedRecordDigest: "4".repeat(64),
      prepared: {
        codecId: "canonical-clone-cbor-v1", payloadSchemaVersion: 1,
        fieldPresenceBase64: "AA", payloadBundleBase64: "AA",
        bodyHash: "2".repeat(64), senderSnapshotDigest: "7".repeat(64),
        recordDigest: "8".repeat(64), recordEncodedBytes: 10,
        preview: { bodyPreview: "repaired", senderSnapshot: { kind: "agent", label: "Codex" } },
      },
    }],
  });
  assert.equal(result.repaired.length, 1);
  assert.equal(db.calls.some((query) => query.name === "message_sender_repair_update_v1"), true);
});
