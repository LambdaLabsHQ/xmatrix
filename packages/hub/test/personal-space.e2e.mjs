import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { prepareTestAgentRun } from "./e2e-utils.mjs";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

async function startWorker(name) {
  const token = `personal-space-${randomUUID()}`;
  const userId = `personal-space-user-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: token,
    XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "ada@example.com",
    XMATRIX_MOCK_AUTH_NAME: name,
  } });
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const listSpaces = async () => (await (await worker.fetch("/api/spaces", { headers })).json()).spaces;
  const ensurePersonal = async () => {
    const response = await worker.fetch("/api/personal-space", { method: "POST", headers });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).space;
  };
  return { worker, token, headers, listSpaces, ensurePersonal };
}

test("a person with no Space gets one personal Space, once", async () => {
  const { worker, listSpaces, ensurePersonal } = await startWorker("Ada Lovelace");
  try {
    assert.deepEqual(await listSpaces(), []);
    const space = await ensurePersonal();
    assert.equal(space.name, "Ada Lovelace's Space");
    assert.deepEqual((await listSpaces()).map((item) => item.id), [space.id]);

    // A second tab or a retry finds a Space already there and adds nothing.
    assert.equal(await ensurePersonal(), null);
    assert.deepEqual((await listSpaces()).map((item) => item.id), [space.id]);
  } finally {
    await worker.stop();
  }
});

test("a person who already has a Space is not given a personal one", async () => {
  const { worker, headers, listSpaces, ensurePersonal } = await startWorker("Grace Hopper");
  try {
    const created = await worker.fetch("/api/spaces", {
      method: "POST", headers, body: JSON.stringify({ name: "Invited team" }),
    });
    assert.equal(created.status, 200, await created.clone().text());
    const { space } = await created.json();
    assert.equal(await ensurePersonal(), null);
    assert.deepEqual((await listSpaces()).map((item) => item.id), [space.id]);
  } finally {
    await worker.stop();
  }
});

test("an Agent Run cannot create a personal Space for its owner", async () => {
  const { worker, token, headers, ensurePersonal } = await startWorker("Alan Turing");
  try {
    const space = await ensurePersonal();
    const prepared = await prepareTestAgentRun(worker, {
      name: `personal-space-agent-${randomUUID()}`, agentType: "codex", spaceId: space.id,
    }, token);
    const denied = await worker.fetch("/api/personal-space", {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${prepared.token}` },
    });
    assert.equal(denied.status, 401);
  } finally {
    await worker.stop();
  }
});
