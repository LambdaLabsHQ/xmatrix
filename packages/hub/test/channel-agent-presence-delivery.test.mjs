import assert from "node:assert/strict";
import test from "node:test";

import {
  channelAgentPresenceDeliveryBody,
  parseChannelAgentPresenceDelivery,
} from "../src/runtime-transport/channel-agent-presence-delivery.ts";
import { serializedAgentsFromPresence } from "../src/live-agent-instance-read.ts";

const channelId = "channel-1";

function recipient(overrides = {}) {
  return { userId: "user-1", digest: true, card: true, channel: true, immediate: [], ...overrides };
}

test("a presence body shares one card and drops the channel when the frame is too large", () => {
  const card = { id: "instance-1", name: "Codex", type: "agent", lifetime: "short", status: "online" };
  const channel = { id: channelId, name: "work", topic: "x".repeat(300_000) };
  const body = channelAgentPresenceDeliveryBody({
    channelId,
    reason: "update",
    card,
    channel,
    recipients: [recipient(), recipient({ userId: "user-2", card: false })],
  });
  const parsed = JSON.parse(body);
  assert.equal(parsed.channel, undefined);
  assert.equal(parsed.card.id, "instance-1");
  assert.deepEqual(parsed.recipients.map((item) => item.channel), [false, false]);
  assert.equal(parseChannelAgentPresenceDelivery(parsed).card.id, "instance-1");
});

test("a presence frame with no recipients or a mismatched channel is refused", () => {
  assert.equal(channelAgentPresenceDeliveryBody({
    channelId, reason: "connect", recipients: [],
  }), undefined);
  assert.equal(parseChannelAgentPresenceDelivery({
    channelId, reason: "update", recipients: [recipient()], channel: { id: "other" },
  }), undefined);
  assert.equal(parseChannelAgentPresenceDelivery({
    channelId, reason: "nope", recipients: [recipient()],
  }), undefined);
  assert.equal(parseChannelAgentPresenceDelivery({
    channelId,
    reason: "disconnect",
    recipients: [recipient({ immediate: ["lifecycle", "observable", "lifecycle"] })],
  }), undefined);
  const accepted = parseChannelAgentPresenceDelivery({
    channelId,
    reason: "disconnect",
    lifecycle: { type: "agent_lifecycle", channelId, agentId: "agent-1" },
    observable: { type: "observable_event", event: { id: "event-1", type: "agent_disconnected" } },
    recipients: [recipient({ digest: false, card: false, channel: false, immediate: ["lifecycle", "observable"] })],
  });
  assert.ok(accepted);
  assert.deepEqual(accepted.recipients[0].immediate, ["lifecycle", "observable"]);
  assert.equal(accepted.lifecycle.type, "agent_lifecycle");
});

test("the online agent list is one row per live instance, ordered and capped", () => {
  const members = new Map([
    ["channel-b", {
      "instance-b": {
        kind: "agent",
        label: "Zed",
        email: "zed@example.test",
        registration: { ownerUserId: "owner-b", machineId: "machine-1", harness: "codex" },
        instances: [{
          id: "instance-b", channelInstanceId: "2", label: "Zed:2", status: "busy",
          connectedAt: "2026-10-04T00:00:00.000Z", lastSeenAt: "2026-10-04T00:01:00.000Z",
          model: "gpt-5.4",
        }, {
          id: "instance-offline", label: "Zed:3", status: "offline",
          connectedAt: "2026-10-04T00:00:00.000Z", lastSeenAt: "2026-10-04T00:01:00.000Z",
        }],
      },
    }],
    ["channel-a", {
      "instance-a": {
        kind: "agent",
        label: "Ada",
        registration: { ownerUserId: "owner-a", machineId: "machine-1", harness: "claude" },
        instances: [{
          id: "instance-a", label: "Ada:1", status: "online",
          connectedAt: "2026-10-04T00:00:00.000Z", lastSeenAt: "2026-10-04T00:01:00.000Z",
        }],
      },
    }],
  ]);
  const listed = serializedAgentsFromPresence(members);
  assert.deepEqual(listed.map((agent) => agent.instanceId), ["instance-a", "instance-b"]);
  assert.equal(listed[0].id, "instance-a");
  assert.equal(listed[0].name, "Ada");
  assert.equal(listed[0].userId, "owner-a");
  assert.equal(listed[0].metadata.channelId, "channel-a");
  assert.equal(listed[1].model, "gpt-5.4");
  assert.equal(listed[1].email, "zed@example.test");
  assert.deepEqual(listed[1].instances.map((instance) => instance.id), ["instance-b"]);
});
