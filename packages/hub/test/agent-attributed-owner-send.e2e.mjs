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

test("a Run's owner posts as its live registered Instance", async () => {
  const worker = await startPgHubWorker({ vars: { XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
    [OWNER.token]: { id: OWNER.id, email: OWNER.email, name: "Attributed Owner" },
    [OTHER.token]: { id: OTHER.id, email: OTHER.email, name: "Attributed Other" },
  }) } });
  try {
    const space = (await requestJson(worker, OWNER.token, "/api/spaces", { method: "POST",
      body: JSON.stringify({ name: `attributed-${randomUUID()}` }) })).payload.space;
    const invite = (await requestJson(worker, OWNER.token, `/api/spaces/${encodeURIComponent(space.id)}/invites`, {
      method: "POST", body: JSON.stringify({ role: "member" }) })).payload.invite;
    assert.equal((await requestJson(worker, OTHER.token, `/api/space-invites/${encodeURIComponent(invite.token)}/accept`,
      { method: "POST" })).response.status, 200);
    const channel = (await requestJson(worker, OWNER.token, "/api/channels", { method: "POST",
      body: JSON.stringify({ spaceId: space.id, name: "attributed", mode: "open" }) })).payload.channel;
    const agent = await prepareTestAgentRun(worker, { name: `attributed-${randomUUID().slice(0, 8)}`,
      agentType: "codex", targetChannelId: channel.id, metadata: { tool: "codex",
        machineId: `machine:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`, hostId: `host-${randomUUID()}` } }, OWNER.token);
    const { instanceId, runId, executionKey } = agent.body.metadata;
    const send = (token, overrides = {}) => requestJson(worker, token,
      `/api/channels/${encodeURIComponent(channel.id)}/messages`, { method: "POST", body: JSON.stringify({
        body: "posted by the owner as the Run", clientMessageId: randomUUID(),
        senderAgentId: instanceId, senderRunId: runId, senderExecutionKey: executionKey, ...overrides }) });

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
  } finally {
    await worker.stop();
  }
});
