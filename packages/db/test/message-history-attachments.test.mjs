import assert from "node:assert/strict";
import test from "node:test";
import { hydrateHistoryAttachmentVersions } from "../dist/message-history-attachments.js";

test("legacy thread media recovers the current version from an exact scoped attachment edge", async () => {
  const attachment = { id: "copy-image", contentHash: "a".repeat(64) };
  const page = [{ message_id: "copy", recalled_at: null, attachments_json: [attachment] }];
  await hydrateHistoryAttachmentVersions({ async query(query) {
    assert.deepEqual(query.values, ["space", "thread", JSON.stringify([
      { messageId: "copy", attachmentId: "copy-image" },
    ])]);
    assert.equal(query.maxRows, 1);
    return [{ message_id: "copy", attachment_id: "copy-image", version: "7",
      content_hash: attachment.contentHash }];
  } }, "space", "thread", page);
  assert.equal(attachment.version, 7);
});

test("history never guesses a missing, mismatched, or invalid attachment version", async () => {
  for (const row of [undefined,
    { message_id: "other", attachment_id: "image", version: 1, content_hash: "hash" },
    { message_id: "copy", attachment_id: "image", version: 1, content_hash: "other" },
    { message_id: "copy", attachment_id: "image", version: 0, content_hash: "hash" },
  ]) {
    const attachment = { id: "image", contentHash: "hash" };
    await hydrateHistoryAttachmentVersions({ async query() { return row ? [row] : []; } },
      "space", "thread", [{ message_id: "copy", recalled_at: null, attachments_json: [attachment] }]);
    assert.equal(attachment.version, undefined);
  }
});

test("complete and recalled attachments do not require an additional history read", async () => {
  await hydrateHistoryAttachmentVersions({ async query() { assert.fail("unexpected query"); } },
    "space", "thread", [
      { message_id: "complete", recalled_at: null, attachments_json: [{ id: "image", version: 3 }] },
      { message_id: "recalled", recalled_at: "2026-09-10", attachments_json: [{ id: "image" }] },
    ]);
});
