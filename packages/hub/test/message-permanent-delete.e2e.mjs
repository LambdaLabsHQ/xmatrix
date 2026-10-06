import {
  assert,
  channelHistory,
  connectUser,
  json,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  test,
} from "./agent-mention-spawn.fixture.mjs";

import { startPgHubWorker, inTestTransaction } from "./agent-launch-postgres.fixture.mjs";

test("permanent deletion removes live and recalled messages", async () => {
  const ownerId = `message-delete-${randomUUID()}`;
  const deniedToken = `denied-${randomUUID()}`;
  const worker = await startPgHubWorker({
    vars: {
      SCOPED_CONTROL_FACT_MATERIALIZATION: "",
      CHANNEL_FAMILY_FACT_MATERIALIZATION: "",
      // Empty deployment selectors must still use PG through the real HTTP and Runtime ports.
      ...Object.fromEntries(["USER_PREFERENCE", "CHANNEL_CATALOG", "SPACE_ROOT", "SPACE_MEMBERSHIP", "BILLING", "CONTENT", "MESSAGE", "WORKSPACE", "SHARED_MEMORY", "ASSISTANT_MEMORY", "AGENT_APP_POLICY", "HUMAN_PROFILE", "RUNTIME_FACT", "MACHINE_CONTROL", "TRACE_ACCESS_FACT", "AUTOMATION"].map((name) => [`${name}_AUTHORITY`, ""])),
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: ownerId,
      XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
        [MOCK_TOKEN]: { id: ownerId, email: "message-delete@example.com", name: "Message Delete" },
        [deniedToken]: { id: `denied-${randomUUID()}`, email: "denied@example.com", name: "Denied" },
      }),
      XMATRIX_MOCK_AUTH_EMAIL: "message-delete@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Message Delete",
    },
  });
  try {
    const auth = {
      Authorization: `Bearer ${MOCK_TOKEN}`,
      "content-type": "application/json",
    };
    const space = (await json(await worker.fetch("/api/spaces", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: `Message Delete ${randomUUID()}` }),
    }))).space;
    const channel = (await json(await worker.fetch("/api/channels", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ spaceId: space.id, name: `delete-${randomUUID()}`, mode: "closed" }),
    }))).channel;
    const recalled = (await postChannelMessage(worker, MOCK_TOKEN, channel.id, "recall then delete")).message;
    const direct = (await postChannelMessage(worker, MOCK_TOKEN, channel.id, "delete directly")).message;

    const user = await connectUser(worker);
    const denied = await connectUser(worker, deniedToken);
    const historyRequest = `pg-history-${randomUUID()}`;
    user.ws.send(JSON.stringify({ type: "user_focus_channel", channelId: channel.id,
      historyLimit: 50, requestId: historyRequest }));
    const liveHistory = await user.inbox.waitFor(
      (message) => message.type === "channel_history" && message.requestId === historyRequest,
      "PostgreSQL Runtime history through the production Human port",
    );
    assert.deepEqual(liveHistory.messages.map((message) => message.messageId),
      [recalled.messageId, direct.messageId]);
    const deniedHistoryRequest = `denied-history-${randomUUID()}`;
    denied.ws.send(JSON.stringify({ type: "user_focus_channel", channelId: channel.id,
      historyLimit: 50, requestId: deniedHistoryRequest }));
    const deniedHistory = await denied.inbox.waitFor(
      (message) => message.requestId === deniedHistoryRequest,
      "private Runtime history denial",
    );
    assert.equal(deniedHistory.type, "error");
    const recallResponse = await worker.fetch(
      `/api/channels/${encodeURIComponent(channel.id)}/messages/${encodeURIComponent(recalled.messageId)}`,
      { method: "DELETE", headers: auth },
    );
    assert.equal(recallResponse.status, 200);
    const recallPayload = await json(recallResponse);
    assert.equal(typeof recallPayload.message.recalledAt, "string");
    const recallUpdate = await user.inbox.waitFor(
      (message) => message.type === "channel_message_updated" && message.message.messageId === recalled.messageId,
      "committed recall tombstone",
    );
    assert.equal(recallUpdate.message.body, "");
    assert.equal(recallUpdate.message.recalledAt, recallPayload.message.recalledAt);
    assert.equal("deletedAt" in recallUpdate.message, false);
    for (const messageId of [recalled.messageId, direct.messageId]) {
      const path = `/api/channels/${encodeURIComponent(channel.id)}/messages/${encodeURIComponent(messageId)}?permanent=true`;
      const replayHeaders = { ...auth, "x-xmatrix-idempotency-key": `delete:${messageId}` };
      const unauthorized = await worker.fetch(path, {
        method: "DELETE", headers: { ...auth, Authorization: `Bearer ${deniedToken}` },
      });
      assert.equal(unauthorized.status, 404);
      const response = await worker.fetch(path, { method: "DELETE", headers: replayHeaders });
      assert.equal(response.status, 200);
      const payload = await json(response);
      assert.equal(typeof payload.message.deletedAt, "string");
      assert.equal("recalledAt" in payload.message, false);

      const update = await user.inbox.waitFor(
        (message) => message.type === "channel_message_updated"
          && message.channelId === channel.id && message.message.messageId === messageId,
        `committed tombstone for ${messageId}`,
      );
      assert.equal(typeof update.message.from.email, "string");
      assert.equal(update.message.body, "");
      assert.equal(update.message.deletedAt, payload.message.deletedAt);
      assert.equal("recalledAt" in update.message, false);
      assert.equal("attachments" in update.message, false);
      const replay = await worker.fetch(path, { method: "DELETE", headers: replayHeaders });
      assert.equal(replay.status, 200, await replay.clone().text());
      assert.deepEqual((await json(replay)).message, payload.message);
      await assert.rejects(denied.inbox.waitFor(
        (message) => message.type === "channel_message_updated" && message.channelId === channel.id,
        "private tombstone leaked to nonmember", 300,
      ), /Timed out/u);
    }
    user.ws.close();
    denied.ws.close();

    const history = await channelHistory(worker, MOCK_TOKEN, channel.id);
    assert.equal(history.messages.some((message) => message.messageId === recalled.messageId), false);
    assert.equal(history.messages.some((message) => message.messageId === direct.messageId), false);
    const mutations = await inTestTransaction((tx) => tx.query({
      text: "SELECT message_id, mutation_kind, COUNT(*)::int AS count FROM data.message_mutations WHERE channel_id=$1 AND mutation_kind IN ('recall','delete') GROUP BY message_id, mutation_kind",
      values: [channel.id], maxRows: 3,
    }));
    assert.equal(mutations.length, 3);
    assert.equal(mutations.every((row) => row.count === 1), true, "delete retries must not advance the ledger twice");
  } finally {
    await worker.stop();
  }
});
