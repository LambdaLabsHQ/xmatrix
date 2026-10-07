import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentChannelHistory } from "../src/runtime-transport/agent-channel-history.ts";

const CHANNEL_ID = "channel-ack-cursor";
const TAIL = 20;

const CORPUS = Array.from({ length: TAIL }, (_, index) => ({
  messageId: `message-${index + 1}`,
  channelId: CHANNEL_ID,
  sequence: index + 1,
  from: { kind: "user", label: "Yiming", userId: "user-1", email: "yiming@example.com" },
  body: `message ${index + 1}`,
  sentAt: new Date(Date.UTC(2026, 7, 4, 12, index)).toISOString(),
}));

/** Session identity is stable across instances; the session object is not. */
function session(instanceId, channelDeliveryEnabled = true) {
  return {
    principal: {
      ownerUserId: "user-1",
      agentId: "agent-1",
      runId: "run-1",
      executionKey: "exec-1",
      channelId: CHANNEL_ID,
    },
    run: { instanceId, channelId: CHANNEL_ID, channelDeliveryEnabled },
  };
}

function port(ackedSequence, corpus = CORPUS) {
  const read = async ({ limit, afterSequence }) => {
    const messages = afterSequence !== undefined
      ? corpus.filter((entry) => entry.sequence > afterSequence).slice(0, limit)
      : corpus.slice(Math.max(0, corpus.length - limit));
    return { messages, headSequence: TAIL, ackedSequence };
  };
  return new AgentChannelHistory({ read, serializeAgent: () => ({ id: "agent-1" }) });
}

function intents(batch) {
  return batch
    .filter((frame) => frame.type === "channel_history_replay")
    .map((frame) => frame.deliveryIntent ?? "work");
}

function replayed(batch) {
  // The frame carries the message nested; sequence belongs to the message.
  return batch
    .filter((frame) => frame.type === "channel_history_replay")
    .map((frame) => frame.message.sequence);
}

test("a successor instance is not served the backlog its predecessor acknowledged", async () => {
  // Reborn / live-update replacement: a brand new process, so it offers no
  // waterline and joins with the interactive history limit.
  const batch = await port(17).join(session("instance-2"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 50,
  });
  assert.deepEqual(replayed(batch), [18, 19, 20]);
});

test("a headless successor catches up after the durable ack cursor, not from zero", async () => {
  // historyLimit 0 is the headless/daemon-managed join shape.
  const batch = await port(19).join(session("instance-3"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 0,
  });
  assert.deepEqual(replayed(batch), [20]);
});

test("an agent that acknowledged everything gets no replay on a fresh join", async () => {
  const batch = await port(TAIL).join(session("instance-4"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 50,
  });
  assert.deepEqual(replayed(batch), []);
});

test("a newcomer with no ack cursor still gets the joining context window", async () => {
  const batch = await port(0).join(session("instance-1"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 5,
  });
  assert.deepEqual(replayed(batch), [16, 17, 18, 19, 20]);
});

test("a stale client waterline cannot rewind a reconnect below the ack cursor", async () => {
  const active = port(TAIL);
  const runtime = session("instance-5");
  await active.join(runtime, { type: "join_channel", channelId: CHANNEL_ID, historyLimit: 0 });
  // A wrapper that lost its in-memory waterline can ask from an old sequence;
  // the durable ack cursor still bounds what it is served.
  const batch = await active.replay(runtime, {
    type: "replay_channel_history",
    channelId: CHANNEL_ID,
    afterSequence: 3,
    historyLimit: 50,
  });
  assert.deepEqual(replayed(batch), []);
});

/**
 * The join window and a catch-up backlog are different claims, and the runtime
 * acts on that difference: a newcomer's orientation window used to arrive in
 * the same frame shape as undelivered work, so joining a busy channel handed
 * the Instance the last N messages as work.
 */
test("a newcomer's join window is context, and a catch-up backlog is work", async () => {
  const birth = await port(0).join(session("instance-6"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 3,
  });
  assert.deepEqual(replayed(birth), [18, 19, 20]);
  assert.deepEqual(intents(birth), ["context", "context", "context"]);

  // Same three messages, but now the cursor says this principal never received
  // them. That is work, and it must stay work.
  const catchUp = await port(17).join(session("instance-7"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 50,
  });
  assert.deepEqual(replayed(catchUp), [18, 19, 20]);
  assert.deepEqual(intents(catchUp), ["work", "work", "work"]);
});

test("a reconnect that offers its own waterline is work, never orientation", async () => {
  // The wrapper kept a waterline across the drop, so it rejoins with
  // afterSequence rather than as a newcomer.
  const batch = await port(17).join(session("instance-8"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    afterSequence: 18,
    historyLimit: 50,
  });
  assert.deepEqual(replayed(batch), [19, 20]);
  assert.deepEqual(intents(batch), ["work", "work"]);
});

test("catch-up acknowledges Auto summons without handing observers new work", async () => {
  const corpus = CORPUS.map((message) => message.sequence === 18
    ? { ...message, body: "@auto repo:owner/repo audit", metadata: { xmatrixProvenance: "scheduled_automation" } }
    : message);
  const history = port(17, corpus);
  const runtime = session("sleeping-observer");
  const batch = await history.join(runtime, {
    type: "join_channel", channelId: CHANNEL_ID, historyLimit: 0,
  });
  assert.deepEqual(replayed(batch), [18, 19, 20]);
  assert.deepEqual(intents(batch), ["context", "work", "work"]);
  assert.deepEqual(replayed(await history.replay(runtime, {
    type: "replay_channel_history", channelId: CHANNEL_ID, historyLimit: 50,
  })), []);
});

/**
 * Channel 9806a6a6 (2026-09-23): a headless Instance summoned at #1405 read the
 * channel into its first prompt, then joined with historyLimit 0. The Agent's
 * shared durable cursor sat where a predecessor stopped (#1385), so the join
 * served #1386-#1404 — an old `/kill all`, a stop command, two old summons —
 * as fresh work. The Instance's own read is a floor the Hub must honor.
 */
test("a headless first join floors catch-up at the history the client already read", async () => {
  const batch = await port(5).join(session("instance-headless"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 0,
    afterSequence: 17,
  });
  assert.deepEqual(replayed(batch), [18, 19, 20]);
  assert.deepEqual(intents(batch), ["work", "work", "work"]);
});

test("a headless reconnect waterline raises the floor but never rewinds the ack cursor", async () => {
  const behind = await port(17).join(session("instance-behind-waterline"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 0,
    afterSequence: 3,
  });
  assert.deepEqual(replayed(behind), [18, 19, 20]);

  // A waterline past the head cannot park the socket cursor beyond messages
  // that do not exist yet.
  const history = port(0);
  const runtime = session("instance-future-waterline");
  const ahead = await history.join(runtime, {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 0,
    afterSequence: 999,
  });
  assert.deepEqual(replayed(ahead), []);
  const replay = await history.replay(runtime, {
    type: "replay_channel_history",
    channelId: CHANNEL_ID,
    historyLimit: 50,
  });
  assert.deepEqual(replayed(replay), []);
});

test("a headless join owed nothing is not served the channel's oldest messages as work", async () => {
  // A fresh principal (a registration Instance is its own subject) with no
  // ack and no read: "after 0" used to replay #1..#20 as work.
  const batch = await port(0).join(session("instance-fresh-headless"), {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 0,
  });
  assert.deepEqual(batch.map((frame) => frame.type), ["channel_joined"]);
});

test("a system management run advances to tail without receiving channel history", async () => {
  const history = port(0);
  const runtime = session("instance-system", false);
  const joined = await history.join(runtime, {
    type: "join_channel",
    channelId: CHANNEL_ID,
    historyLimit: 0,
  });
  assert.deepEqual(joined.map((frame) => frame.type), ["channel_joined"]);
  assert.deepEqual(replayed(joined), []);

  const replay = await history.replay(runtime, {
    type: "replay_channel_history",
    channelId: CHANNEL_ID,
    afterSequence: 0,
    historyLimit: 50,
  });
  assert.deepEqual(replay, []);

  const explicit = await history.history(runtime, {
    type: "get_channel_history",
    channelId: CHANNEL_ID,
    limit: 50,
  });
  assert.deepEqual(explicit.messages, []);
});

test("catch-up skips a relayed reply this Instance wrote to its own cross-Channel link", async () => {
  // Production 2026-09-30: claude:6 answered its own link, restarted, and the
  // relay came back as catch-up work. It is written under the link owner, so
  // only its metadata names the Instance that wrote it.
  const relay = (sequence, replierInstanceId) => ({
    ...CORPUS[sequence - 1],
    messageId: `link-reply:r-${sequence}`,
    metadata: {
      xmatrixProvenance: "cross_channel_reply",
      crossChannelReply: { sourceChannelId: "away", sourceMessageId: `r-${sequence}`,
        linkMessageId: "l-1", replierKind: "agent", replierAgentId: "channel:6", replierInstanceId },
    },
  });
  const corpus = CORPUS.map((entry) => entry.sequence === 19 ? relay(19, "instance-6")
    : entry.sequence === 20 ? relay(20, "instance-7") : entry);
  const batch = await joinAfterCursor18(corpus);
  assert.deepEqual(replayed(batch), [20], "its own relay is dropped; another Instance's reply is work");
});

test("catch-up gives a relayed answer as work only to the Instance that asked", async () => {
  const answer = (sequence, requesterInstanceId) => ({
    ...CORPUS[sequence - 1],
    messageId: `link-reply:a-${sequence}`,
    metadata: {
      xmatrixProvenance: "cross_channel_reply",
      crossChannelReply: { sourceChannelId: "away", sourceMessageId: `a-${sequence}`,
        linkMessageId: "l-1", replierKind: "agent", replierAgentId: "away:3",
        replierInstanceId: "away:3", requesterInstanceId },
    },
  });
  const corpus = CORPUS.map((entry) => entry.sequence === 19 ? answer(19, "instance-6")
    : entry.sequence === 20 ? answer(20, "instance-7") : entry);
  const batch = await joinAfterCursor18(corpus);
  assert.deepEqual(replayed(batch), [19, 20]);
  assert.deepEqual(intents(batch), ["work", "context"], "its own request's answer is work; another's is context");
});

function joinAfterCursor18(corpus) {
  return port(18, corpus).join(session("instance-6"), { type: "join_channel", channelId: CHANNEL_ID, historyLimit: 0 });
}
