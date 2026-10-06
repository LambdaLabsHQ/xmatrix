import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectPostgresMessage,
  parseMessageInspectionOptions,
} from "../scripts/postgres-message-inspect.ts";
import {
  prepareRelayV2MessageRecord,
} from "../src/relay-v2-message-record.ts";
import {
  base64UrlEncodeBytes,
} from "../src/relay-v2-primitives.ts";

async function messageRow(overrides = {}) {
  const prepared = await prepareRelayV2MessageRecord({
    messageId: "message-1", channelId: "channel-1", timelineSequence: 7,
    senderKind: "user", senderId: "user-1", messageKind: "xmatrix.message.text",
    payloadSchemaVersion: 1, entityVersion: 1, sentAt: "2026-09-13T00:00:00.000Z",
    body: "private body", senderSnapshot: { identityId: "user:user-1", label: "Alice" },
    residual: { replyToMessageId: "message-0" },
  });
  return {
    space_id: "space-1", channel_id: "channel-1", message_id: "message-1",
    timeline_sequence: 7, entity_version: 1, author_kind: "user", author_id: "user-1",
    message_kind: "xmatrix.message.text", sent_at: "2026-09-13T00:00:00.000Z",
    edited_at: null, recalled_at: null, deleted_at: null,
    codec_id: prepared.codecId, payload_schema_version: prepared.payloadSchemaVersion,
    field_presence_base64: base64UrlEncodeBytes(prepared.fieldPresenceBytes),
    payload_bundle_base64: base64UrlEncodeBytes(prepared.payloadBundleBytes), legacy_body: null,
    body_hash: prepared.bodyHash, sender_snapshot_digest: prepared.senderSnapshotDigest,
    record_digest: prepared.recordDigest, record_encoded_bytes: prepared.recordEncodedBytes,
    ...overrides,
  };
}

function client(rows) {
  const calls = [];
  return {
    calls,
    async query(text) {
      calls.push(text);
      if (text.includes("FROM data.messages WHERE")) return { rows };
      if (text.includes("FROM data.message_attachment_refs")) return { rows: [{ attachment_id: "a" }] };
      if (text.includes("FROM data.message_mutations")) return { rows: [{ mutation_kind: "create" }] };
      if (text.includes("FROM data.outbox")) return { rows: [{ status: "pending" }] };
      if (text.includes("FROM data.idempotency_keys")) return { rows: [{ command_kind: "message-append" }] };
      return { rows: [] };
    },
  };
}

test("message inspection is read-only, verifies the codec, and hides body by default", async () => {
  const fake = client([await messageRow()]);
  const report = await inspectPostgresMessage(fake, parseMessageInspectionOptions([
    "--message-id=message-1", "--space-id=space-1", "--preview-repair",
  ]));
  assert.equal(report.verification.status, "ok");
  assert.equal(report.message.body, undefined);
  assert.deepEqual(report.message.sender, { identityId: "user:user-1", label: "Alice" });
  assert.deepEqual(report.message.residualKeys, ["replyToMessageId"]);
  assert.equal(report.attachments.length, 1);
  assert.equal(report.repairPreview.executesWrites, false);
  assert.match(report.repairPreview.sql, /ROLLBACK;/u);
  assert.equal(fake.calls[0], "BEGIN TRANSACTION READ ONLY");
  assert.equal(fake.calls.at(-1), "COMMIT");
  assert.equal(fake.calls.some((sql) => /\b(?:UPDATE|DELETE|INSERT)\b/iu.test(sql)), false);
});

test("message inspection reveals body only explicitly and reports digest mismatch", async () => {
  const fake = client([await messageRow({ record_digest: "0".repeat(64) })]);
  const report = await inspectPostgresMessage(fake, parseMessageInspectionOptions([
    "--message-id=message-1", "--include-body",
  ]));
  assert.equal(report.message.body, "private body");
  assert.equal(report.verification.status, "mismatch");
  assert.equal(report.verification.checks.recordDigest, false);
});

test("message inspection handles missing payload and rejects ambiguous ids", async () => {
  const missing = client([await messageRow({ payload_bundle_base64: null })]);
  const report = await inspectPostgresMessage(missing, parseMessageInspectionOptions([
    "--message-id=message-1",
  ]));
  assert.equal(report.verification.status, "payload_unavailable");
  const ambiguous = client([await messageRow(), await messageRow({ space_id: "space-2" })]);
  await assert.rejects(inspectPostgresMessage(ambiguous, parseMessageInspectionOptions([
    "--message-id=message-1",
  ])), /ambiguous/u);
  assert.equal(ambiguous.calls.at(-1), "ROLLBACK");
});

test("message inspection accepts only bounded explicit selectors", () => {
  assert.throws(() => parseMessageInspectionOptions([]), /message-id is required/u);
  assert.throws(() => parseMessageInspectionOptions(["--message-id=x", "--write"]), /Unknown/u);
  assert.throws(() => parseMessageInspectionOptions([`--message-id=${"x".repeat(301)}`]), /invalid/u);
});
