import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentChannelLiveDelivery, parseHumanChannelLiveDelivery } from "../src/runtime-transport/channel-live-delivery.ts";
import { agentTurnFailureAppendCommand } from "../src/runtime-transport/agent-turn-failure-notice.ts";

const notice = agentTurnFailureAppendCommand({
  runId: "run-1", instanceId: "bc32149d-b76d-5173-8384-272cfcc65081:1",
  executionKey: "execution-1", agentId: "codex", agentName: "codex", ownerUserId: "owner-1",
  channelId: "channel-1", senderSnapshot: {},
  detail: "Codex error: Selected model is at capacity. Please try a different model.",
});
const envelope = {
  channelId: "channel-1", messageId: notice.messageId, body: notice.body,
  sequence: 1, sentAt: "2026-10-12T14:01:54.828Z", from: { kind: "agent", label: "codex" },
  recipientUserIds: ["owner-1"], metadata: notice.payload.residual.appMetadata,
};

test("a committed turn failure notice reaches both live audiences (XMATRIX-HUB-7C)", () => {
  assert.ok(notice.messageId.length > 160, "reproduce the generated ID that Runtime rejected");
  for (const parse of [parseAgentChannelLiveDelivery, parseHumanChannelLiveDelivery]) {
    const delivery = parse(envelope);
    assert.ok(delivery, "the authority-accepted notice must be deliverable");
    assert.equal(delivery.messageId, notice.messageId);
    assert.equal(delivery.body, notice.body);
    // Delivery preserves the committed metadata, including additive evidence;
    // the notice builder owns its schema, not either audience's parser.
    assert.deepEqual(delivery.metadata, envelope.metadata);
  }
});

test("live message IDs preserve the authority's 300-byte bound", () => {
  for (const parse of [parseAgentChannelLiveDelivery, parseHumanChannelLiveDelivery]) {
    for (const messageId of ["x".repeat(300), "界".repeat(100)]) {
      assert.equal(parse({ ...envelope, messageId })?.messageId, messageId);
    }
    for (const messageId of ["x".repeat(301), "界".repeat(101), "", "   ", null]) {
      assert.equal(parse({ ...envelope, messageId }), undefined);
    }
    assert.equal(parse({ ...envelope, channelId: "x".repeat(161) }), undefined);
    assert.equal(parse({ ...envelope, sequence: 0 }), undefined);
    assert.equal(parse({ ...envelope, body: "x".repeat(64 * 1024 + 1) }), undefined);
  }
});
