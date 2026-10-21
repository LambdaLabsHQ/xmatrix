const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { channelWithOutgoing } = require("./channel-outgoing-preview.ts");

const user = { id: "u1", email: "ada@example.com", name: "Ada", avatarUrl: "https://example.com/ada.png" };
const channel = { id: "c1", spaceId: "s1", name: "Discussion", mode: "open", messageCount: 0 };
const outgoing = (over) => ({ clientMessageId: "m1", channelId: "c1", body: "@auto do we support qwen?", attachments: [],
  appMentions: [], sentAt: "2026-10-21T21:50:00.000Z", status: "pending", ...over });

test("a message on its way is the conversation's last message the moment it is sent", () => {
  const shown = channelWithOutgoing(channel, [outgoing()], user);
  assert.equal(shown.lastMessage.bodyPreview, "@auto do we support qwen?");
  assert.equal(shown.lastMessage.sentAt, "2026-10-21T21:50:00.000Z");
  assert.deepEqual([shown.lastMessage.from.kind, shown.lastMessage.from.label, shown.lastMessage.from.avatarUrl],
    ["user", "Ada", "https://example.com/ada.png"]);
});

test("the newest of several, only this conversation's, and none that failed", () => {
  const shown = channelWithOutgoing(channel, [
    outgoing({ clientMessageId: "a", body: "first", sentAt: "2026-10-21T21:50:00.000Z" }),
    outgoing({ clientMessageId: "b", body: "second", sentAt: "2026-10-21T21:50:01.000Z" }),
    outgoing({ clientMessageId: "c", body: "elsewhere", channelId: "c2", sentAt: "2026-10-21T21:50:02.000Z" }),
    outgoing({ clientMessageId: "d", body: "failed", status: "failed", sentAt: "2026-10-21T21:50:03.000Z" }),
  ], user);
  assert.equal(shown.lastMessage.bodyPreview, "second");
  assert.equal(channelWithOutgoing(channel, [outgoing({ status: "failed" })], user), channel);
});

test("a newer message the conversation already has stays its last; nothing on the way leaves it as it is", () => {
  const answered = { ...channel, lastMessage: { messageId: "x", from: { kind: "agent", label: "claude:1" },
    bodyPreview: "Yes.", sentAt: "2026-10-21T21:50:05.000Z" } };
  assert.equal(channelWithOutgoing(answered, [outgoing()], user), answered);
  assert.equal(channelWithOutgoing(channel, [], user), channel);
});
