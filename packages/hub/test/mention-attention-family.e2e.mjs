import { acceptSpaceMembership } from "./support/space-membership.mjs";
import { bearerJsonRequest } from "./support/bearer-json-request.mjs";
import { websocketInbox as inboxOf } from "./support/websocket-inbox.mjs";
import { startPgHubWorker as startHubWorker, inTestTransaction } from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  humanWsUrl,
  openWebSocket,
} from "./e2e-utils.mjs";

const OWNER = { token: "mention-owner-token", id: "mention-owner", email: "mention-owner@example.com" };
const TARGET = { token: "mention-target-token", id: "mention-target", email: "mention-target@example.com" };
const OTHER = { token: "mention-other-token", id: "mention-other", email: "mention-other@example.com" };


async function requestJson(worker, user, path, init = {}) {
  return bearerJsonRequest(worker, user.token, path, init);
}

function invite(worker, spaceId, user) {
  return acceptSpaceMembership(worker, requestJson, OWNER, user, spaceId);
}

async function setProfile(worker, user, displayName, handle) {
  // Mock authentication does not create account rows. Seed the actual account
  // authority before publishing its profile projection; PG mention resolution
  // reads account handles in the message transaction.
  await inTestTransaction(tx => tx.query({
    text: `INSERT INTO control.auth_users (id,name,email,handle,profile_version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,1,now(),now()) ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name,handle=EXCLUDED.handle,profile_version=EXCLUDED.profile_version`,
    values: [user.id, displayName, user.email, handle],
  }));
  const updated = await requestJson(worker, user, "/__test/human-profile", {
    method: "POST",
    body: JSON.stringify({ userId: user.id, displayName, handle, profileVersion: 1 }),
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
}

async function connectHuman(worker, user) {
  const ws = await openWebSocket(humanWsUrl(worker));
  const inbox = inboxOf(ws);
  ws.send(JSON.stringify({
    type: "human_connect",
    token: user.token,
    requestId: `connect-${user.id}`,
    device: { client: "desktop", version: "0.16.160", protocolVersion: 2 },
  }));
  await inbox.waitFor((message) => message.type === "human_connected", `${user.id} connected`);
  return { ws, inbox };
}

test("family attention targets one Human and clear survives catalog reconciliation", async () => {
  const worker = await startHubWorker({
    vars: {
      PLATFORM_ADMIN_EMAILS: OWNER.email,
      XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
        [OWNER.token]: { id: OWNER.id, email: OWNER.email, name: "Same Display" },
        [TARGET.token]: { id: TARGET.id, email: TARGET.email, name: "Same Display" },
        [OTHER.token]: { id: OTHER.id, email: OTHER.email, name: "Same Display" },
      }),
    },
  });
  const sockets = [];
  try {
    const createdSpace = await requestJson(worker, OWNER, "/api/spaces", {
      method: "POST",
      body: JSON.stringify({ name: `mention-space-${randomUUID()}` }),
    });
    assert.equal(createdSpace.response.status, 200, JSON.stringify(createdSpace.payload));
    const spaceId = createdSpace.payload.space.id;
    await invite(worker, spaceId, TARGET);
    await invite(worker, spaceId, OTHER);
    await setProfile(worker, OWNER, "Same Display", "mention-owner");
    await setProfile(worker, TARGET, "Same Display", "mention-target");
    await setProfile(worker, OTHER, "Same Display", "mention-other");

    const createdChannel = await requestJson(worker, OWNER, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ spaceId, name: "mention-routing", mode: "open" }),
    });
    assert.equal(createdChannel.response.status, 200, JSON.stringify(createdChannel.payload));
    const channelId = createdChannel.payload.channel.id;

    const owner = await connectHuman(worker, OWNER);
    const target = await connectHuman(worker, TARGET);
    const targetSecondDevice = await connectHuman(worker, TARGET);
    const other = await connectHuman(worker, OTHER);
    sockets.push(owner.ws, target.ws, targetSecondDevice.ws, other.ws);

    const sendFrom = async (user, sentChannelId, body, extra = {}, recipients = [owner, target, other]) => {
      const messageId = randomUUID();
      const sent = await requestJson(worker, user, `/api/channels/${encodeURIComponent(sentChannelId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body, clientMessageId: messageId, ...extra }),
      });
      assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
      const predicate = (message) => message.type === "channel_message_received" &&
        message.message?.messageId === messageId;
      return {
        messageId,
        payload: sent.payload,
        frames: await Promise.all(recipients.map((recipient) =>
          recipient.inbox.waitFor(predicate, `${user.id} message`))),
      };
    };
    const send = (body) => sendFrom(OWNER, channelId, body);

    const ordinary = await send("ordinary context for everyone");
    assert.deepEqual(ordinary.frames.map((frame) => frame.notification), [undefined, undefined, undefined]);

    const otherMention = await sendFrom(OTHER, channelId, "Other asks @mention-target to review");
    assert.equal(otherMention.frames[0].notification, undefined);
    assert.equal(otherMention.frames[1].notification.reason, "mention");
    assert.equal(otherMention.frames[2].notification, undefined);

    const mentioned = await send("please review @mention-target");
    assert.equal(mentioned.frames[0].notification, undefined);
    assert.equal(mentioned.frames[1].notification.reason, "mention");
    assert.equal(mentioned.frames[1].notification.attention.lastMessageId, mentioned.messageId);
    assert.equal(mentioned.frames[2].notification, undefined);
    const retriedMention = await requestJson(
      worker,
      OWNER,
      `/api/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          body: "please review @mention-target",
          clientMessageId: mentioned.messageId,
        }),
      },
    );
    assert.equal(retriedMention.response.status, 200, JSON.stringify(retriedMention.payload));
    assert.equal(retriedMention.payload.message.sequence, mentioned.payload.message.sequence);

    const later = await send("ordinary message after the mention");
    assert.deepEqual(later.frames.map((frame) => frame.notification), [undefined, undefined, undefined]);

    const beforeClear = await requestJson(
      worker,
      TARGET,
      `/api/channels?spaceId=${encodeURIComponent(spaceId)}`,
    );
    assert.equal(beforeClear.response.status, 200, JSON.stringify(beforeClear.payload));
    const beforeChannel = beforeClear.payload.channels.find((channel) => channel.id === channelId);
    assert.equal(beforeChannel.attention.lastMessageId, mentioned.messageId);
    assert.equal(beforeChannel.attention.unreadAttentionCount, 2,
      "one mention from another Human plus one retried mention must count exactly twice");
    assert.equal(beforeClear.payload.attentionSnapshot.spaces[0].complete, true);

    const attentionUpdate = (message) => message.type === "observable_event" &&
      message.event?.type === "channel_attention_updated" &&
      message.event?.channelId === channelId;
    const firstDeviceClear = target.inbox.waitFor(attentionUpdate, "first device attention clear");
    const secondDeviceClear = targetSecondDevice.inbox.waitFor(
      attentionUpdate,
      "second device attention clear",
    );
    const mentionSequence = mentioned.frames[1].notification.attention.lastMessageSequence;
    const clears = await Promise.all([0, 1].map(() => requestJson(
      worker,
      TARGET,
      `/api/channels/${encodeURIComponent(channelId)}/read`,
      { method: "POST", body: JSON.stringify({ sequence: mentionSequence }) },
    )));
    for (const cleared of clears) {
      assert.equal(cleared.response.status, 200, JSON.stringify(cleared.payload));
      assert.equal(cleared.payload.readSequence, mentionSequence);
    }
    const clearedChannel = { readSequence: mentionSequence };
    const deviceClearEvents = await Promise.all([firstDeviceClear, secondDeviceClear]);
    assert.ok(deviceClearEvents.every((event) =>
      event.event.metadata.readSequence === clearedChannel.readSequence &&
      event.event.metadata.attention === undefined));

    const afterClear = await requestJson(
      worker,
      TARGET,
      `/api/channels?spaceId=${encodeURIComponent(spaceId)}`,
    );
    assert.equal(afterClear.response.status, 200, JSON.stringify(afterClear.payload));
    const afterChannel = afterClear.payload.channels.find((channel) => channel.id === channelId);
    assert.equal(afterChannel.attention, undefined);
    assert.ok(afterChannel.historyHeadSequence > clearedChannel.readSequence,
      "the ordinary message after the mention must remain unread");
    assert.deepEqual(afterClear.payload.attentionSnapshot.spaces[0].summaries, []);

    // A declared wait stays with its target after they read it, until they respond.
    const read = (body) => requestJson(worker, TARGET, `/api/channels/${encodeURIComponent(channelId)}/read`,
      { method: "POST", body: JSON.stringify(body) });
    const waited = await sendFrom(OWNER, channelId, "@mention-target which one ships?", { awaitsResponse: true });
    const waitedSequence = waited.payload.message.sequence;
    const readWait = await read({ sequence: waitedSequence });
    assert.equal(readWait.response.status, 200, JSON.stringify(readWait.payload));
    assert.equal(readWait.payload.attention?.unreadAttentionCount, 1, "reading a declared wait does not answer it");
    assert.equal(readWait.payload.attention.lastMessageId, waited.messageId);
    const done = await read({ sequence: waitedSequence, responded: true });
    assert.equal(done.response.status, 200, JSON.stringify(done.payload));
    assert.equal(done.payload.attention, undefined, "Done answers it without a reply");

    await sendFrom(OWNER, channelId, "@mention-target and the second one?", { awaitsResponse: true });
    const answer = await sendFrom(TARGET, channelId, "ship the first");
    const answered = await read({ sequence: answer.payload.message.sequence });
    assert.equal(answered.response.status, 200, JSON.stringify(answered.payload));
    assert.equal(answered.payload.attention, undefined, "replying in the conversation answers the wait");

    const selfMention = await send("@mention-owner private note to self");
    assert.deepEqual(selfMention.frames.map((frame) => frame.notification),
      [undefined, undefined, undefined]);

    const reply = await sendFrom(
      TARGET,
      channelId,
      "replying without an explicit mention",
      { replyToMessageId: ordinary.messageId },
    );
    assert.equal(reply.frames[0].notification.reason, "reply");
    assert.equal(reply.frames[1].notification, undefined);
    assert.equal(reply.frames[2].notification, undefined);

    const mentionOutranksReply = await sendFrom(
      TARGET,
      channelId,
      "@mention-owner explicit mention in a reply",
      { replyToMessageId: ordinary.messageId },
    );
    assert.equal(mentionOutranksReply.frames[0].notification.reason, "mention");

    const broadcast = await send("@everyone deployment starts now");
    assert.equal(broadcast.frames[0].notification, undefined);
    assert.equal(broadcast.frames[1].notification.reason, "broadcast");
    assert.equal(broadcast.frames[2].notification.reason, "broadcast");

    // Direct messages are retired: nobody, Human or Agent, gets a 1:1 inbox;
    // they are reached in a conversation.
    const directRoute = await worker.fetch("/api/direct-channels", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER.token}`, "content-type": "application/json" },
      body: JSON.stringify({ spaceId, peer: { kind: "user", id: TARGET.id } }),
    });
    assert.equal(directRoute.status, 404, await directRoute.text());
    const directMetadata = await requestJson(worker, OWNER, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ spaceId, mode: "closed", name: "dm", metadata: {
        kind: "direct", participantKey: `user:${OWNER.id}\nuser:${TARGET.id}`,
        participants: [{ kind: "user", id: OWNER.id }, { kind: "user", id: TARGET.id }],
      } }),
    });
    assert.equal(directMetadata.response.status, 400, JSON.stringify(directMetadata.payload));
    assert.equal(directMetadata.payload.code, "direct_conversation_retired");
  } finally {
    for (const socket of sockets) socket.close();
    await worker.stop();
  }
});
