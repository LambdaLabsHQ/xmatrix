import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const protocolDir = path.join(path.dirname(hubDir), "protocol", "src");

import {
  channelMessage,
} from "../src/runtime-transport/channel-message-frame.ts";
import {
  humanChannelDeliveryFrame,
} from "../src/runtime-transport/human-port.ts";

function protocolSource(file) {
  return fs.readFileSync(path.join(protocolDir, file), "utf8");
}

function declaredFields(source, declaration) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} should exist`);
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n}", open);
  return source
    .slice(open, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z][A-Za-z0-9]*\??:/u.test(line))
    .map((line) => line.split(/\??:/u)[0]);
}

const MESSAGE_FIELDS = new Set(
  declaredFields(protocolSource("channel-message.ts"), "export interface ChannelMessage {"),
);

test("one message shape: there is exactly one declaration of a channel message", () => {
  const authority = protocolSource("authority.ts");
  const human = protocolSource(path.join("connections", "human.ts"));
  const agent = protocolSource(path.join("connections", "agent-instance.ts"));

  // A second declaration is how rich metadata acquired two names and how
  // attachments reached the transport and were dropped: each copy was
  // maintained by hand, and a field missing from one of them failed silently.
  assert.equal(
    authority.includes("interface ChannelHistoryEntry"),
    false,
    "history must read the same ChannelMessage, not a history-only twin",
  );
  for (const [name, source] of [["human", human], ["agent", agent], ["authority", authority]]) {
    assert.equal(
      /extends ChannelMessage\b/u.test(source),
      false,
      `${name} must carry ChannelMessage, not extend it into a second shape`,
    );
  }
});

test("no frame declares a message field at its top level", () => {
  const human = protocolSource(path.join("connections", "human.ts"));
  const agent = protocolSource(path.join("connections", "agent-instance.ts"));

  // This is the guard rail. Anything a frame declares itself is a field some
  // path has to remember to copy; nesting the message removes that chance.
  assert.match(
    human,
    /type: "channel_message_received";\s*\n\s*message: ChannelMessage;/u,
    "the human live frame must carry the message nested",
  );
  const agentFrameFields = declaredFields(agent, "interface AgentChannelDelivery {");
  assert.ok(agentFrameFields.includes("message"), "the agent delivery must carry the message");
  for (const field of agentFrameFields) {
    if (field === "message") continue;
    assert.equal(
      MESSAGE_FIELDS.has(field),
      false,
      `${field} is message content and must travel inside message`,
    );
  }
});

test("the hub frame builder ships exactly the shared message fields", () => {
  // Every declared field populated: what the builder emits is the contract, so a
  // field added to the protocol and forgotten here fails instead of never shipping.
  const framed = channelMessage({
    messageId: "message-1",
    channelId: "channel-1",
    sequence: 4,
    entityVersion: 2,
    bodyHash: "a".repeat(64),
    from: { kind: "user", label: "Yiming", userId: "user-1", email: "yiming@example.com" },
    body: "here is the screenshot",
    sentAt: "2026-08-04T12:00:00.000Z",
    replyToMessageId: "message-0",
    replyTo: { messageId: "message-0", author: "Legend", body: "which screen?" },
    attachments: [{ id: "attachment-1", name: "screenshot.png" }],
    appMentions: [{ token: "@app", appId: "app-1", appName: "App", status: "available" }],
    metadata: { xmatrixSystemNotice: true },
    mentionReadStatuses: [{ targetId: "user:1", targetKind: "user", label: "Yiming", status: "unread" }],
    reactions: [{ emoji: "👍", reactors: [{ identityId: "user:1", label: "Yiming" }] }],
    thread: {
      channelId: "thread-1", updatedAt: "2026-08-04T12:04:00.000Z", replyCount: 1,
      replies: [{
        messageId: "reply-1", channelId: "thread-1", sequence: 2,
        from: { kind: "user", label: "Legend", userId: "user-2", email: "legend@example.com" },
        body: "thread reply", sentAt: "2026-08-04T12:04:00.000Z",
      }],
    },
    editedAt: "2026-08-04T12:05:00.000Z",
    editedBy: { kind: "user", label: "Yiming", userId: "user-1", email: "yiming@example.com" },
    recalledAt: "2026-08-04T12:06:00.000Z",
    recalledBy: { kind: "user", label: "Yiming", userId: "user-1", email: "yiming@example.com" },
  });
  assert.equal(framed.bodyHash, undefined, "recalled content cannot expose a source fingerprint");
  assert.equal(framed.entityVersion, 2, "redaction markers carry the committed entity version");
  // Supersession is derived from the Hub's own annotation, and only for a
  // message that is still there (docs/design/conversation-activity.md §3.3).
  const judgment = [{ namespace: "xmatrix.superseded", authorUserId: "system:xmatrix",
    payload: { supersededBy: "message-5" } }];
  assert.equal(channelMessage({ ...framed, annotations: judgment }).supersededBy, undefined);
  const published = channelMessage({ ...framed, recalledAt: undefined, recalledBy: undefined,
    entityVersion: 2, bodyHash: "a".repeat(64), annotations: judgment });
  assert.equal(published.bodyHash, "a".repeat(64));
  assert.equal(published.entityVersion, 2);
  assert.equal(published.supersededBy, "message-5");
  const deleted = channelMessage({ ...framed, body: "", recalledAt: undefined, recalledBy: undefined,
    deletedAt: "2026-08-04T12:07:00.000Z", entityVersion: 3, bodyHash: "a".repeat(64) });
  assert.equal(deleted.deletedAt, "2026-08-04T12:07:00.000Z");
  assert.equal(deleted.entityVersion, 3);
  assert.equal(deleted.bodyHash, undefined, "deleted content cannot identify a task source");
  assert.deepEqual([...new Set([...Object.keys(framed), ...Object.keys(published), ...Object.keys(deleted)])].sort(), [...MESSAGE_FIELDS].sort());
});

test("a live human frame adds transport facts and nothing else", () => {
  const frame = humanChannelDeliveryFrame({
    messageId: "message-1",
    channelId: "channel-1",
    sequence: 4,
    from: { kind: "user", label: "Yiming", userId: "user-1", email: "yiming@example.com" },
    body: "here is the screenshot",
    sentAt: "2026-08-04T12:00:00.000Z",
    attachments: [{ id: "attachment-1", name: "screenshot.png" }],
    metadata: { xmatrixSystemNotice: true },
    recipientUserIds: ["user-1"],
    clientMessageId: "client-1",
  });

  assert.deepEqual(Object.keys(frame).sort(), ["clientMessageId", "message", "type"]);
  assert.equal(frame.message.messageId, "message-1");
  assert.deepEqual(frame.message.metadata, { xmatrixSystemNotice: true });
  assert.equal(frame.message.attachments.length, 1);
});

test("framing normalizes one message the same way for every audience", () => {
  const framed = channelMessage({
    channelId: " channel-1 ",
    messageId: " message-1 ",
    sequence: 4,
    from: { kind: "user", label: "Yiming", userId: "user-1", email: "yiming@example.com" },
    body: "here is the screenshot",
    sentAt: " 2026-08-04T12:00:00.000Z ",
    replyToMessageId: " message-0 ",
    replyTo: { messageId: "message-0", author: "Legend", body: "which screen?" },
    attachments: [{ id: "attachment-1", name: "screenshot.png" }],
    appMentions: [],
    metadata: { xmatrixSystemNotice: true },
  });

  assert.equal(framed.channelId, "channel-1");
  assert.equal(framed.replyToMessageId, "message-0");
  assert.equal(framed.attachments.length, 1);
  assert.deepEqual(framed.metadata, { xmatrixSystemNotice: true });
  // Empty collections stay absent so a frame never claims an empty attachment set.
  assert.equal("appMentions" in framed, false);
  assert.equal("mentionReadStatuses" in framed, false);
  // A live delivery has accumulated no post-commit state yet.
  assert.equal("reactions" in framed, false);
  assert.equal("editedAt" in framed, false);
  assert.equal("recalledAt" in framed, false);
});

test("a message nobody can address is never framed", () => {
  const base = {
    channelId: "channel-1",
    messageId: "message-1",
    sequence: 4,
    from: { kind: "user", label: "Yiming", userId: "user-1", email: "yiming@example.com" },
    body: "hello",
    sentAt: "2026-08-04T12:00:00.000Z",
  };
  assert.ok(channelMessage(base));
  assert.equal(channelMessage({ ...base, messageId: "  " }), undefined);
  assert.equal(channelMessage({ ...base, sequence: 0 }), undefined);
  assert.equal(channelMessage({ ...base, from: undefined }), undefined);
  assert.equal(channelMessage({ ...base, body: undefined }), undefined);
  assert.equal(channelMessage({ ...base, sentAt: "" }), undefined);
});
