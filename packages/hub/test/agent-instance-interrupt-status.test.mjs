import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentInstanceRuntimeTransport,
  AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES,
} from "../src/runtime-transport/agent-instance-port.ts";
import { agentInstanceAttachment, FakeSocket } from "./support/runtime-transport.mjs";

function attachment(instanceStatus, runtimeStatus) {
  return agentInstanceAttachment({ run: { instanceStatus },
    session: runtimeStatus ? { presentation: { runtimeState: { status: runtimeStatus } } } : {} });
}

function liveTransport() {
  return new AgentInstanceRuntimeTransport({
    capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES),
  });
}

/** Rehydrate a live Instance socket on the transport. */
function connect(transport, value) {
  const socket = new FakeSocket();
  assert.equal(transport.rehydrate(socket, value), true);
  return socket;
}

/** A sibling Instance of the same Agent in channel-1, with a Run of its own. */
function siblingAttachment(instanceId, runId) {
  const value = attachment("online", "running");
  value.session.run.instanceId = instanceId;
  value.session.run.runId = runId;
  value.session.principal.runId = runId;
  return value;
}

const HUMAN_SENDER = {
  kind: "user",
  identityId: "user:user-1",
  userId: "user-1",
  label: "User",
  email: "user@example.test",
};

/** Deliver one Channel message to a single live Instance; returns the delivery and its frame. */
function deliverToOne(value, message) {
  const transport = liveTransport();
  const socket = connect(transport, value);
  const delivery = transport.deliverChannelMessage({
    channelId: "channel-1",
    sentAt: new Date().toISOString(),
    ...message,
  });
  return { delivery, frame: socket.sent.at(-1) };
}

function deliveryFrame(instanceStatus, runtimeStatus) {
  const { delivery, frame } = deliverToOne(attachment(instanceStatus, runtimeStatus), {
    messageId: "message-1",
    sequence: 1,
    body: "continue",
    from: HUMAN_SENDER,
  });
  assert.deepEqual(delivery, { matched: 1, delivered: 1, interrupted: 1 });
  return frame;
}

test("human steering requests native interruption despite stale idle presence", () => {
  assert.equal(deliveryFrame("idle", "running").interruptRequested, true);
  assert.equal(deliveryFrame("online", undefined).interruptRequested, true);
});

test("an idle runtime also receives the interrupt hint and remains the turn authority", () => {
  assert.equal(deliveryFrame("idle", "idle").interruptRequested, true);
});

test("a visible stop command reaches live Agents only as non-interrupting context", () => {
  const { delivery, frame } = deliverToOne(attachment("online", "running"), {
    messageId: "stop-message-1",
    sequence: 2,
    body: "@Agent:1:stop",
    from: HUMAN_SENDER,
  });
  assert.deepEqual(delivery, { matched: 1, delivered: 1, interrupted: 0 });
  assert.equal(frame.deliveryIntent, "context");
  assert.equal(frame.interruptRequested, undefined);
});

test("an ordinary Agent peer reply is queued without cancelling the active turn", () => {
  const { delivery, frame } = deliverToOne(attachment("online", "running"), {
    messageId: "peer-message-1",
    sequence: 2,
    body: "my independent answer",
    from: {
      kind: "agent",
      identityId: "agent-peer",
      userId: "user-1",
      label: "Peer",
      email: "peer@example.test",
    },
  });
  assert.deepEqual(delivery, { matched: 1, delivered: 1, interrupted: 0 });
  assert.equal(frame.deliveryIntent, undefined);
  assert.equal(frame.interruptRequested, undefined);
});

test("scheduled Automation interrupts only its exact live instance target", () => {
  const transport = liveTransport();
  const exactAttachment = attachment("idle", "idle");
  exactAttachment.session.run.channelInstanceId = "2";
  const socket = connect(transport, exactAttachment);

  const deliver = (body) => transport.deliverChannelMessage({
    channelId: "channel-1",
    messageId: `message-${socket.sent.length + 1}`,
    sequence: socket.sent.length + 1,
    body,
    from: {
      kind: "agent",
      identityId: "agent-1",
      userId: "user-1",
      label: "Agent",
      email: "user@example.test",
    },
    sentAt: new Date().toISOString(),
    metadata: { xmatrixProvenance: "scheduled_automation" },
  });

  assert.deepEqual(deliver("@Agent:1 inspect"), { matched: 1, delivered: 1, interrupted: 0 });
  assert.equal(socket.sent.at(-1).deliveryIntent, "context");
  assert.equal(socket.sent.at(-1).interruptRequested, undefined);

  assert.deepEqual(deliver("@Agent:2 inspect"), { matched: 1, delivered: 1, interrupted: 1 });
  assert.equal(socket.sent.at(-1).deliveryIntent, undefined);
  assert.equal(socket.sent.at(-1).interruptRequested, true);
});

test("the authoring Instance never receives its own message back, its siblings still do", () => {
  const transport = liveTransport();
  const author = connect(transport, attachment("online", "running"));
  const sibling = connect(transport, siblingAttachment("instance-2", "run-2"));

  // The product sender presentation stamps a Channel-summoned Instance's
  // identity as `agent:<agentId>`; the author must still recognise itself.
  for (const identityId of ["agent-1", "agent:agent-1"]) {
    author.sent.length = 0;
    sibling.sent.length = 0;
    assert.deepEqual(
      transport.deliverChannelMessage({
        channelId: "channel-1",
        messageId: `own-${identityId}`,
        sequence: 3,
        body: "progress update",
        from: {
          kind: "agent",
          identityId,
          instanceId: "instance-1",
          userId: "user-1",
          label: "Agent:1",
          email: "user@example.test",
        },
        sentAt: new Date().toISOString(),
      }),
      { matched: 1, delivered: 1, interrupted: 0 },
    );
    assert.equal(author.sent.length, 0);
    assert.equal(sibling.sent.at(-1).message.messageId, `own-${identityId}`);
  }
});

test("a relayed reply to a cross-Channel link skips the Instance that wrote the reply", () => {
  const transport = liveTransport();
  const replier = connect(transport, attachment("online", "running"));
  const sibling = connect(transport, siblingAttachment("instance-2", "run-2"));

  // The relay is written under the link owner, a human: without the replier's
  // Instance in its metadata it would steer (interrupt) the Instance that wrote it.
  const relay = (crossChannelReply) => ({
    channelId: "channel-1",
    messageId: `link-reply:${crossChannelReply.sourceMessageId}`,
    sequence: 4,
    body: "answering my own link",
    from: { kind: "user", identityId: "user:user-1", userId: "user-1", label: "Agent:1" },
    sentAt: new Date().toISOString(),
    metadata: { xmatrixProvenance: "cross_channel_reply", crossChannelReply },
  });
  const base = { sourceChannelId: "channel-away", linkMessageId: "link-1", replierKind: "agent" };

  assert.deepEqual(
    transport.deliverChannelMessage(relay({ ...base, sourceMessageId: "r-1",
      replierAgentId: "agent-1", replierInstanceId: "instance-1" })),
    { matched: 1, delivered: 1, interrupted: 1 },
  );
  assert.equal(replier.sent.length, 0, "the replier never receives its own answer as a turn");
  assert.equal(sibling.sent.at(-1).message.messageId, "link-reply:r-1", "its sibling still hears it");

  // Production: the relay's Agent id is the sender snapshot's (`<channel>:<N>`),
  // not the socket principal's; the Instance id alone identifies the replier.
  replier.sent.length = 0;
  transport.deliverChannelMessage(relay({ ...base, sourceMessageId: "r-2",
    replierAgentId: "channel-1:6", replierInstanceId: "instance-1" }));
  assert.equal(replier.sent.length, 0);
  transport.deliverChannelMessage(relay({ ...base, sourceMessageId: "r-5",
    replierAgentId: "agent-1", replierInstanceId: "instance-2" }));
  assert.equal(replier.sent.at(-1).message.messageId, "link-reply:r-5", "a sibling's reply is work");

  // A human's reply, or one from before the replier was recorded, reaches everyone.
  replier.sent.length = 0;
  transport.deliverChannelMessage(relay({ ...base, sourceMessageId: "r-3", replierKind: "user" }));
  transport.deliverChannelMessage(relay({ ...base, sourceMessageId: "r-4" }));
  assert.deepEqual(replier.sent.map((frame) => frame.message.messageId), ["link-reply:r-3", "link-reply:r-4"]);
});

test("a relayed answer is work only for the live Instance that asked; the others get context", () => {
  // Production 2026-10-01: claude:52's answer woke idle claude:48 and claude:50
  // in x-matrix with "your cross-Channel request", which none of them sent.
  const transport = liveTransport();
  const instance = (instanceId) => connect(transport, siblingAttachment(instanceId, `run-${instanceId}`));
  const requester = instance("channel-1:48");
  const bystander = instance("channel-1:50");
  const relay = (sourceMessageId, requesterInstanceId) => ({
    channelId: "channel-1",
    messageId: `link-reply:${sourceMessageId}`,
    sequence: 5,
    body: "here is the answer",
    from: { kind: "user", identityId: "user:user-1", userId: "user-1", label: "codex:3" },
    sentAt: new Date().toISOString(),
    metadata: { xmatrixProvenance: "cross_channel_reply", crossChannelReply: {
      sourceChannelId: "away", sourceMessageId, linkMessageId: "l-1", replierKind: "agent",
      replierAgentId: "away:3", replierInstanceId: "away:3", requesterInstanceId } },
  });

  assert.deepEqual(transport.deliverChannelMessage(relay("r-1", "channel-1:48")),
    { matched: 2, delivered: 2, interrupted: 1 });
  assert.equal(requester.sent.at(-1).deliveryIntent, undefined, "work for the Instance that asked");
  assert.equal(requester.sent.at(-1).interruptRequested, true);
  assert.equal(bystander.sent.at(-1).deliveryIntent, "context", "context for everyone else");
  assert.equal(bystander.sent.at(-1).interruptRequested, undefined, "and it never interrupts them");

  // Once the Instance that asked is gone, the answer is work for whoever is here.
  transport.deliverChannelMessage(relay("r-2", "channel-1:9"));
  assert.equal(bystander.sent.at(-1).message.messageId, "link-reply:r-2");
  assert.equal(bystander.sent.at(-1).deliveryIntent, undefined);
});

test("a tombstone reaches its author without acknowledgement, interruption, or a new turn", () => {
  const at = new Date().toISOString();
  const { delivery, frame } = deliverToOne(attachment("idle", "running"), {
    deliveryKind: "update", messageId: "message-1", sequence: 1,
    body: "", deletedAt: at, sentAt: at,
    from: { kind: "agent", agentId: "agent-1", identityId: "agent-1", label: "Agent" },
  });
  assert.deepEqual(delivery, { matched: 1, delivered: 1, interrupted: 0 });
  assert.equal(frame.type, "channel_message_updated");
  assert.equal(frame.message.deletedAt, at);
  assert.equal("ackRequired" in frame, false);
  assert.equal("interruptRequested" in frame, false);
});
