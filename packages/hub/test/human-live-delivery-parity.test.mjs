import { parseChannelTombstoneDelivery } from "../src/runtime-transport/channel-tombstone-delivery.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  humanChannelDeliveryFrame,
} from "../src/runtime-transport/human-port.ts";

function deliveryInput(extra) {
  return {
    channelId: "channel-1",
    messageId: "message-1",
    sequence: 7,
    body: "here is the screenshot",
    from: { kind: "user", label: "Yiming", userId: "user-2", email: "yiming@example.com" },
    sentAt: "2026-08-04T12:00:00.000Z",
    recipientUserIds: ["user-1"],
    ...extra,
  };
}

test("a live delivery carries everything the same message shows after a reload", () => {
  const attachments = [{ id: "attachment-1", name: "screenshot.png", contentType: "image/png", size: 1024 }];
  const replyTo = { messageId: "message-0", author: "Legend", body: "which screen?" };
  const appMentions = [{ token: "@app", appId: "app-1", appName: "App", status: "available" }];
  const mentionReadStatuses = [{ targetId: "user:1", targetKind: "user", label: "Yiming", status: "unread" }];

  const frame = humanChannelDeliveryFrame(deliveryInput({
    attachments,
    replyTo,
    appMentions,
    mentionReadStatuses,
    replyToMessageId: "message-0",
    metadata: { xmatrixSystemNotice: true },
  }));
  // Attachments were passed by the commit path and silently dropped here, so an
  // image arrived as an empty message until the reader refetched history.
  assert.deepEqual(frame.message.attachments, attachments);
  assert.deepEqual(frame.message.replyTo, replyTo);
  assert.deepEqual(frame.message.appMentions, appMentions);
  assert.deepEqual(frame.message.mentionReadStatuses, mentionReadStatuses);
  assert.deepEqual(frame.message.metadata, { xmatrixSystemNotice: true });
  assert.equal(frame.message.replyToMessageId, "message-0");
});

test("optional delivery fields stay absent rather than arriving empty", () => {
  const frame = humanChannelDeliveryFrame(
    deliveryInput({ attachments: [], appMentions: [], mentionReadStatuses: [] }),
  );
  assert.equal("attachments" in frame.message, false);
  assert.equal("replyTo" in frame.message, false);
  assert.equal("appMentions" in frame.message, false);
  assert.equal("mentionReadStatuses" in frame.message, false);
  assert.equal("metadata" in frame.message, false);
});

test("an unaddressable delivery produces no frame at all", () => {
  assert.equal(humanChannelDeliveryFrame(deliveryInput({ recipientUserIds: [] })), undefined);
  assert.equal(humanChannelDeliveryFrame(deliveryInput({ sequence: 0 })), undefined);
});

test("notification metadata is constructed for only the addressed Human", () => {
  const attention = {
    channelId: "channel-1",
    unreadAttentionCount: 1,
    lastMessageId: "message-1",
    lastMessageSequence: 7,
    primaryTriggerKind: "mention",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
  const input = deliveryInput({
    recipientUserIds: ["user-1", "user-3"],
    recipientNotifications: [{
      userId: "user-1",
      notification: { reason: "mention", attention },
    }],
  });
  assert.deepEqual(humanChannelDeliveryFrame(input, "user-1").notification, {
    reason: "mention",
    attention,
  });
  assert.equal(humanChannelDeliveryFrame(input, "user-3").notification, undefined);
  assert.equal("recipientNotifications" in humanChannelDeliveryFrame(input, "user-1"), false);
});

test("a tombstone update contains no notification or fresh-message framing", () => {
  const at = "2026-10-02T00:00:00.000Z";
  const frame = humanChannelDeliveryFrame(deliveryInput({
    deliveryKind: "update", body: "", deletedAt: at,
    clientMessageId: "stale-echo", recipientNotifications: [{
      userId: "user-1", notification: { reason: "direct" },
    }],
  }), "user-1");
  assert.equal(frame.type, "channel_message_updated");
  assert.equal(frame.channelId, "channel-1");
  assert.equal(frame.message.deletedAt, at);
  assert.equal("notification" in frame, false);
  assert.equal("clientMessageId" in frame, false);
});

test("internal tombstone admission rejects work, private payload, and ambiguous state", () => {
  const input = { deliveryKind: "update", body: "", entityVersion: 3, deletedAt: "2026-10-02T00:00:00.000Z" };
  assert.deepEqual(parseChannelTombstoneDelivery(input), { deliveryKind: "update", entityVersion: 3, deletedAt: input.deletedAt });
  for (const extra of [
    { deliveryKind: "new" }, { body: "old private body" }, { entityVersion: 0 },
    { deletedAt: "invalid" }, { deletedAt: undefined }, { recalledAt: input.deletedAt },
    { attachments: [] }, { metadata: {} }, { recipientNotifications: [] }, { clientMessageId: "echo" },
  ]) assert.equal(parseChannelTombstoneDelivery({ ...input, ...extra }), null, JSON.stringify(extra));
  assert.deepEqual(parseChannelTombstoneDelivery({ body: "ordinary append" }), {});
});

test("presence for unshown conversations leaves as one digest per window, newest per Instance", async () => {
  const { HumanPresenceDigests } = await import("../src/runtime-transport/human-presence-digest.ts");
  const sent = [];
  const digests = new HumanPresenceDigests((socket, message) => sent.push({ socket, message }), 5);
  const socket = {};
  const card = (id, instances, activity) => ({ id, instances: instances.map((instance) => ({ id: instance })), activity });
  digests.add(socket, card("agent:a", ["i1"], "first"));
  digests.add(socket, card("agent:b", ["i2"], "other"));
  digests.add(socket, card("agent:a", ["i1"], "latest"));
  assert.deepEqual(sent, []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.type, "presence_digest");
  assert.deepEqual(sent[0].message.agents.map((agent) => agent.activity), ["other", "latest"]);
  digests.add(socket, card("agent:a", ["i1"], "next window"));
  digests.flush(socket);
  assert.deepEqual(sent[1].message.agents.map((agent) => agent.activity), ["next window"]);
  digests.flush(socket);
  assert.equal(sent.length, 2, "an empty window sends nothing");
});
