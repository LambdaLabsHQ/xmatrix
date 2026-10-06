const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { threadReplyPreviews } = require("./thread-reply-preview.ts");

const reply = (sequence, kind = "user", overrides = {}) => ({
  messageId: `reply-${sequence}`, channelId: "thread-1", sequence,
  sentAt: `2026-09-13T10:00:0${sequence}Z`, body: `Message ${sequence}`,
  from: { kind, label: kind }, ...overrides,
});

test("latest two replies include agents and apps and render oldest to newest", () => {
  const previews = threadReplyPreviews("thread-1", "root", "copy", [
    reply(3, "app"), reply(1), reply(2, "agent"),
  ]);
  assert.deepEqual(previews.map((item) => item.id), ["reply-2", "reply-3"]);
  assert.deepEqual(previews.map((item) => item.author), ["agent", "app"]);
});

test("cached replies merge with summary without duplicates or unrelated channel roots", () => {
  const previews = threadReplyPreviews("thread-1", "root", "copy", [reply(2)], [
    reply(1), reply(2), reply(3), reply(4, "user", { messageId: "root" }),
    reply(5, "user", { messageId: "copy" }), reply(6, "user", { channelId: "other" }),
  ]);
  assert.deepEqual(previews.map((item) => item.id), ["reply-2", "reply-3"]);
});

test("recalls override stale cached bodies and attachment-only replies have copy", () => {
  const previews = threadReplyPreviews("thread-1", "root", undefined, [
    reply(2, "agent", { recalledAt: "2026-09-13T11:00:00Z" }),
    reply(3, "user", { body: "", attachments: [{ id: "attachment" }] }),
  ], [reply(2, "agent")]);
  assert.deepEqual(previews.map((item) => item.body), ["Message recalled", "1 attachment"]);
});

test("empty and single-reply threads do not invent additional previews", () => {
  assert.deepEqual(threadReplyPreviews(undefined, "root", undefined), []);
  assert.equal(threadReplyPreviews("thread-1", "root", undefined, [reply(1)]).length, 1);
});
