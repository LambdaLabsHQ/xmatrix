import { bearerJsonRequest } from "./support/bearer-json-request.mjs";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createFileScopedHubWorker } from "./e2e-utils.mjs";

const MOCK_TOKEN = "channel-duplicate-names-token";
const workerFixture = createFileScopedHubWorker({
  vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: "channel-duplicate-names-user",
    XMATRIX_MOCK_AUTH_EMAIL: "channel-duplicate-names@example.com",
    XMATRIX_MOCK_AUTH_NAME: "Channel Duplicate Names",
  },
}, startPgHubWorker);

async function requestJson(worker, path, init = {}) {
  return bearerJsonRequest(worker, MOCK_TOKEN, path, init, { trimEmpty: true });
}

async function createChannel(worker, spaceId, name) {
  return requestJson(worker, "/api/channels", {
    method: "POST",
    body: JSON.stringify({ spaceId, name, mode: "open" }),
  });
}

test("conversations in one Space may share a presentation name", async () => {
  const worker = await workerFixture.get();
  const name = `duplicate-${randomUUID()}`;
  const space = await requestJson(worker, "/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name: `Duplicate names ${randomUUID()}` }),
  });
  assert.equal(space.response.status, 200, JSON.stringify(space.payload));
  const spaceId = space.payload.space.id;

  const first = await createChannel(worker, spaceId, name);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  const second = await createChannel(worker, spaceId, name);
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  const other = await createChannel(worker, spaceId, `other-${randomUUID()}`);
  assert.equal(other.response.status, 200, JSON.stringify(other.payload));
  const renamed = await requestJson(
    worker,
    `/api/channels/${encodeURIComponent(other.payload.channel.id)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  assert.equal(renamed.response.status, 200, JSON.stringify(renamed.payload));
  assert.equal(renamed.payload.channel.name, name);
  assert.equal(new Set([
    first.payload.channel.id,
    second.payload.channel.id,
    renamed.payload.channel.id,
  ]).size, 3);
});
