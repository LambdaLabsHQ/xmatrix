import { test } from "node:test";
import assert from "node:assert/strict";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { prepareTestAgentRun } from "./e2e-utils.mjs";

/* One worker per account: the mock session is the only identity it serves. */
async function withAccount(name, check) {
  const token = `personal-space-${crypto.randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: token,
    XMATRIX_MOCK_AUTH_USER_ID: `personal-space-user-${crypto.randomUUID()}`,
    XMATRIX_MOCK_AUTH_EMAIL: "person@example.com",
    XMATRIX_MOCK_AUTH_NAME: name,
  } });
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (path, init = {}) => {
    const response = await worker.fetch(path, { headers, ...init });
    return { status: response.status, body: await response.json() };
  };
  const spaceIds = async () => (await call("/api/spaces")).body.spaces.map((space) => space.id);
  const personal = async () => {
    const { status, body } = await call("/api/personal-space", { method: "POST" });
    assert.equal(status, 200, JSON.stringify(body));
    return body.space;
  };
  try {
    await check({ worker, token, headers, call, spaceIds, personal });
  } finally {
    await worker.stop();
  }
}

test("a person with no Space gets one personal Space, once", () =>
  withAccount("Ada Lovelace", async ({ spaceIds, personal }) => {
    assert.deepEqual(await spaceIds(), []);
    const space = await personal();
    assert.equal(space.name, "Ada Lovelace's Space");
    assert.deepEqual(await spaceIds(), [space.id]);
    // A second tab or a retry finds a Space already there and adds nothing.
    assert.equal(await personal(), null);
    assert.deepEqual(await spaceIds(), [space.id]);
  }));

test("someone who already has a Space, as an invitee does, is given no personal one", () =>
  withAccount("Grace Hopper", async ({ call, spaceIds, personal }) => {
    const created = await call("/api/spaces", { method: "POST", body: JSON.stringify({ name: "Invited team" }) });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(await personal(), null);
    assert.deepEqual(await spaceIds(), [created.body.space.id]);
  }));

test("an Agent Run cannot create a personal Space for its owner", () =>
  withAccount("Alan Turing", async ({ worker, token, headers, personal }) => {
    const space = await personal();
    const run = await prepareTestAgentRun(worker, {
      name: `personal-space-agent-${crypto.randomUUID()}`, agentType: "codex", spaceId: space.id,
    }, token);
    const denied = await worker.fetch("/api/personal-space", {
      method: "POST", headers: { ...headers, Authorization: `Bearer ${run.token}` },
    });
    assert.equal(denied.status, 401);
  }));
