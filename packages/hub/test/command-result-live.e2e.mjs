import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { bearerJsonRequest } from "./support/bearer-json-request.mjs";
import { websocketInbox as inboxOf } from "./support/websocket-inbox.mjs";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { humanWsUrl, openWebSocket } from "./e2e-utils.mjs";

const OWNER = { token: "command-result-owner-token", id: "command-result-owner", email: "command-result-owner@example.com" };

/* A command's answer is recorded on the command and pushed to the people
   holding the Channel, so its chip answers without anyone reloading. */
test("a model or effort answer reaches a connected person live and stays on the command", async () => {
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_USERS: JSON.stringify({ [OWNER.token]: { id: OWNER.id, email: OWNER.email, name: "Owner" } }),
  } });
  let ws;
  try {
    const request = (path, init) => bearerJsonRequest(worker, OWNER.token, path, init);
    const space = await request("/api/spaces", { method: "POST", body: JSON.stringify({ name: `command-result-${randomUUID()}` }) });
    assert.equal(space.response.status, 200, JSON.stringify(space.payload));
    const channel = await request("/api/channels", { method: "POST",
      body: JSON.stringify({ spaceId: space.payload.space.id, name: "command-result", mode: "open" }) });
    assert.equal(channel.response.status, 200, JSON.stringify(channel.payload));
    const channelId = channel.payload.channel.id;

    ws = await openWebSocket(humanWsUrl(worker));
    const inbox = inboxOf(ws);
    ws.send(JSON.stringify({ type: "human_connect", token: OWNER.token, requestId: "connect-owner",
      device: { client: "desktop", version: "0.16.160", protocolVersion: 2 } }));
    await inbox.waitFor((message) => message.type === "human_connected", "owner connected");

    const sent = await request(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST", body: JSON.stringify({ body: "@claude:1 /effort", clientMessageId: randomUUID() }) });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
    const messageId = sent.payload.message.messageId;

    const pushed = await inbox.waitFor((message) => message.type === "observable_event" &&
      message.event?.type === "channel_message_interactions_updated" && message.event.metadata?.messageId === messageId,
      "command result pushed");
    assert.equal(pushed.event.channelId, channelId);
    assert.deepEqual(pushed.event.metadata.payload.controls, [{ kind: "effort", target: "claude:1", status: "no_instance" }]);

    const history = await request(`/api/channels/${encodeURIComponent(channelId)}/history?limit=20`);
    const command = history.payload.messages.find((message) => message.messageId === messageId);
    assert.deepEqual(command.commandResult, { controls: [{ kind: "effort", target: "claude:1", status: "no_instance" }] });
    assert.equal(history.payload.messages.length, 1, "the answer is not another message");
  } finally {
    ws?.close();
    await worker.stop();
  }
});
