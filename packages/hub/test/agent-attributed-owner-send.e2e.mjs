import { bearerJsonRequest } from "./support/bearer-json-request.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { prepareTestAgentRun } from "./e2e-utils.mjs";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

/* A Run's owner may post as that live Run with their own session when the
   Agent host has no Run token (the CLI does this inside an Agent's
   environment). The Run's actor is its Instance: attribution used to look the
   sender up as an Agent Profile, which a registered Run does not have, and
   refused every such post. */

const OWNER = { token: "attributed-owner-token", id: "attributed-owner", email: "attributed-owner@example.com" };
const OTHER = { token: "attributed-other-token", id: "attributed-other", email: "attributed-other@example.com" };

async function requestJson(worker, token, path, init = {}) {
  return bearerJsonRequest(worker, token, path, init, { inheritHeaders: false });
}

/** A Space with OWNER and OTHER, one open Channel and OWNER's registered Run in it. */
async function withAttributedRun(name, work) {
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
    [OWNER.token]: { id: OWNER.id, email: OWNER.email, name: "Attributed Owner" },
    [OTHER.token]: { id: OTHER.id, email: OTHER.email, name: "Attributed Other" },
  }) } });
  try {
    const space = (await requestJson(worker, OWNER.token, "/api/spaces", { method: "POST",
      body: JSON.stringify({ name: `${name}-${randomUUID()}` }) })).payload.space;
    const invite = (await requestJson(worker, OWNER.token, `/api/spaces/${encodeURIComponent(space.id)}/invites`, {
      method: "POST", body: JSON.stringify({ role: "member" }) })).payload.invite;
    assert.equal((await requestJson(worker, OTHER.token, `/api/space-invites/${encodeURIComponent(invite.token)}/accept`,
      { method: "POST" })).response.status, 200);
    const channel = (await requestJson(worker, OWNER.token, "/api/channels", { method: "POST",
      body: JSON.stringify({ spaceId: space.id, name, mode: "open" }) })).payload.channel;
    const agent = await prepareTestAgentRun(worker, { name: `${name}-${randomUUID().slice(0, 8)}`,
      agentType: "codex", targetChannelId: channel.id, metadata: { tool: "codex",
        machineId: `machine:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`, hostId: `host-${randomUUID()}` } }, OWNER.token);
    const { instanceId, runId, executionKey } = agent.body.metadata;
    const path = `/api/channels/${encodeURIComponent(channel.id)}/messages`;
    const post = (token, body) => requestJson(worker, token, path, { method: "POST", body: JSON.stringify(body) });
    const send = (token, overrides = {}) => post(token, { body: "posted by the owner as the Run",
      clientMessageId: randomUUID(), senderAgentId: instanceId, senderRunId: runId, senderExecutionKey: executionKey,
      ...overrides });
    await work({ worker, channel, instanceId, post, send });
  } finally {
    await worker.stop();
  }
}

test("a Run's owner posts as its live registered Instance", () => withAttributedRun("attributed",
  async ({ instanceId, send }) => {
    const sent = await send(OWNER.token);
    assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
    const { from } = sent.payload.message;
    assert.equal(from.kind, "agent");
    assert.equal(from.agentId, instanceId);
    assert.equal(from.instanceId, instanceId);
    assert.equal(from.identityId, `agent:${instanceId}`);

    // Only the Run's owner, with its exact execution binding, may attribute.
    assert.equal((await send(OTHER.token)).response.status, 403);
    assert.equal((await send(OWNER.token, { senderExecutionKey: "stale" })).response.status, 403);
  }));

/* Read before you write: an Agent that says how far it has read a Channel is
   not appended over a newer message from someone else. Its own messages after
   that point do not count, and a retry of a send that already committed is
   answered by its receipt, however far the Channel has moved since. */
test("an Agent send is refused while a newer message from someone else is unread", () => withAttributedRun(
  "read-before-send", async ({ worker, channel, post, send }) => {
    const human = (token, body) => post(token, { body, clientMessageId: randomUUID() });
    const asAgent = (body, readThroughSequence, clientMessageId = randomUUID()) =>
      send(OWNER.token, { body, readThroughSequence, clientMessageId });
    const committed = (sent) => {
      assert.equal(sent.response.status, 200, JSON.stringify(sent.payload));
      return Number(sent.payload.message.sequence);
    };

    const read = committed(await human(OWNER.token, "please look at this"));
    const progress = await asAgent("on it", read);
    committed(progress);
    // Its own progress message is newer than what it read, and is no reason to refuse.
    committed(await asAgent("still on it", read));

    const correction = committed(await human(OTHER.token, "wait, do the other thing"));
    const refused = await asAgent("done with the first thing", read);
    assert.equal(refused.response.status, 409, JSON.stringify(refused.payload));
    assert.equal(refused.payload.code, "channel_read_stale");
    assert.match(refused.payload.error, /^channel_read_stale: 1 newer message/u);
    const after = await requestJson(worker, OWNER.token,
      `/api/channels/${encodeURIComponent(channel.id)}/history?afterSequence=${correction}`);
    assert.equal(after.response.status, 200, JSON.stringify(after.payload));
    assert.deepEqual(after.payload.messages.map((message) => message.body), [], "the refused send appended nothing");

    // A retry of a send that already committed returns its receipt.
    const replay = await asAgent("on it", read, progress.payload.message.messageId);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
    assert.equal(Number(replay.payload.message.sequence), Number(progress.payload.message.sequence));

    // Having read the correction, the Agent's answer goes through.
    committed(await asAgent("switching to the other thing", correction));
    assert.equal((await asAgent("unreadable", -1)).response.status, 400);
  }));
