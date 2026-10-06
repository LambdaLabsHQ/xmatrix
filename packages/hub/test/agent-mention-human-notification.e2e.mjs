import { bearerJsonRequest } from "./support/bearer-json-request.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { humanWsUrl, openWebSocket, prepareTestAgentRun } from "./e2e-utils.mjs";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { inWorkerTransaction } from "./registration-launch.fixture.mjs";

/* A registered Agent that @-mentions a Human must reach them the way a Human's
   mention does: the live frame carries the mention and the Human's unread
   attention summary, so their client can badge the Channel. On PostgreSQL the
   summary used to be omitted, and the Runtime drops a mention without one. */

const OWNER = { token: "agent-mention-owner-token", id: "agent-mention-owner", email: "agent-mention-owner@example.com" };
const TARGET = { token: "agent-mention-target-token", id: "agent-mention-target", email: "agent-mention-target@example.com" };

async function requestJson(worker, user, path, init = {}) {
  return bearerJsonRequest(worker, user.token, path, init, { inheritHeaders: false });
}

test("a registered Agent's @mention notifies the Human with their attention summary", async () => {
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
    [OWNER.token]: { id: OWNER.id, email: OWNER.email, name: "Mention Owner" },
    [TARGET.token]: { id: TARGET.id, email: TARGET.email, name: "Mention Target" },
  }) } });
  let ws;
  try {
    const space = (await requestJson(worker, OWNER, "/api/spaces", { method: "POST",
      body: JSON.stringify({ name: `agent-mention-${randomUUID()}` }) })).payload.space;
    const invite = (await requestJson(worker, OWNER, `/api/spaces/${encodeURIComponent(space.id)}/invites`, {
      method: "POST", body: JSON.stringify({ role: "member" }) })).payload.invite;
    assert.equal((await requestJson(worker, TARGET, `/api/space-invites/${encodeURIComponent(invite.token)}/accept`,
      { method: "POST" })).response.status, 200);
    // A Human's handle lives on their auth identity, which mock sign-in never writes.
    await inWorkerTransaction(worker, tx => tx.query({ text: `INSERT INTO control.auth_users
        (id,name,email,created_at,updated_at,handle,profile_version) VALUES ($1,$2,$3,now(),now(),$4,1)
      ON CONFLICT (id) DO UPDATE SET handle=EXCLUDED.handle`,
    values: [TARGET.id, "Mention Target", TARGET.email, "mention-target"] }));
    const channel = (await requestJson(worker, OWNER, "/api/channels", { method: "POST",
      body: JSON.stringify({ spaceId: space.id, name: "agent-mention", mode: "open" }) })).payload.channel;

    ws = await openWebSocket(humanWsUrl(worker));
    const frames = [];
    ws.addEventListener("message", event => frames.push(JSON.parse(event.data)));
    ws.send(JSON.stringify({ type: "human_connect", token: TARGET.token, requestId: "connect-target",
      device: { client: "desktop", version: "0.16.160", protocolVersion: 2 } }));

    const agent = await prepareTestAgentRun(worker, { name: `mention-agent-${randomUUID()}`, agentType: "codex",
      targetChannelId: channel.id, metadata: { tool: "codex", machineId: `machine:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
        hostId: `host-${randomUUID()}` } }, OWNER.token);
    const messageId = randomUUID();
    const sent = await requestJson(worker, { token: agent.token }, `/api/channels/${encodeURIComponent(channel.id)}/messages`,
      { method: "POST", body: JSON.stringify({ body: "Agent asks @mention-target to review", clientMessageId: messageId }) });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));

    const deadline = Date.now() + 15_000;
    let frame;
    while (!frame && Date.now() < deadline) {
      frame = frames.find(message => message.type === "channel_message_received" &&
        message.message?.messageId === messageId);
      if (!frame) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(frame, "the mentioned Human receives the Agent's message");
    assert.equal(frame.message.from.kind, "agent");
    assert.equal(frame.notification?.reason, "mention");
    assert.equal(frame.notification.attention.lastMessageId, messageId);
    assert.equal(frame.notification.attention.primaryTriggerKind, "mention");
  } finally {
    ws?.close();
    await worker.stop();
  }
});
