import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { prepareTestAgentRun } from "./e2e-utils.mjs";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

test("Agent lists its Profile Space without inheriting owner memberships or writes", async () => {
  const token = "agent-list-spaces-owner";
  const userId = `space-reader-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: token,
    XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "space-reader@example.com",
    XMATRIX_MOCK_AUTH_NAME: "Space Reader",
  } });
  try {
    const ownerHeaders = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await worker.fetch("/api/spaces", {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Agent team" }),
    });
    assert.equal(created.status, 200, await created.clone().text());
    const { space } = await created.json();
    const prepared = await prepareTestAgentRun(worker, {
      name: `space-agent-${randomUUID()}`, agentType: "codex", spaceId: space.id,
    }, token);
    const headers = { Authorization: `Bearer ${prepared.token}`, "content-type": "application/json" };
    const otherCreated = await worker.fetch("/api/spaces", {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Owner's other Space" }),
    });
    assert.equal(otherCreated.status, 200, await otherCreated.clone().text());
    const { space: other } = await otherCreated.json();
    const ownerSpaces = await (await worker.fetch("/api/spaces", { headers: ownerHeaders })).json();
    assert.deepEqual(ownerSpaces.spaces.map((item) => item.id).sort(), [space.id, other.id].sort());

    // Caller hints cannot select the owner's other Space or impersonate a user.
    const response = await worker.fetch(`/api/spaces?spaceId=${encodeURIComponent(other.id)}&userId=${userId}`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.deepEqual(body.spaces.map((item) => item.id), [space.id]);
    assert.equal(body.spaces[0].name, "Agent team");
    assert.equal(body.spaces[0].pendingJoinRequestCount, undefined);

    const createDenied = await worker.fetch("/api/spaces", {
      method: "POST", headers, body: JSON.stringify({ name: "Not authorized" }),
    });
    assert.equal(createDenied.status, 401);
    assert.match(await createDenied.text(), /not available to Agent run principals/u);
    const otherDenied = await worker.fetch(`/api/spaces/${encodeURIComponent(other.id)}`, { headers });
    assert.equal(otherDenied.status, 401);
    const moveDenied = await worker.fetch(`/api/channels/${prepared.body.metadata.autoJoinChannelId}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ spaceId: other.id }),
    });
    // A Run never moves a Channel out of its Space.
    assert.equal(moveDenied.status, 403);
    assert.equal((await moveDenied.json()).code, "agent_run_space_mismatch");
  } finally {
    await worker.stop();
  }
});
