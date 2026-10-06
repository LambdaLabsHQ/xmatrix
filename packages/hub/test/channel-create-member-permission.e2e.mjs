import { acceptSpaceMembership } from "./support/space-membership.mjs";
import { bearerJsonRequest } from "./support/bearer-json-request.mjs";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { createFileScopedHubWorker } from "./e2e-utils.mjs";

/**
 * Channel creation is member-level. The app shows the create button to every
 * Space member , so Authority answering 403 for anyone
 * below admin shipped as a button that cannot work.
 */
const OWNER_TOKEN = "channel-create-permission-owner-token";
const OWNER_USER_ID = "channel-create-permission-owner";
const MEMBER_TOKEN = "channel-create-permission-member-token";
const MEMBER_USER_ID = "channel-create-permission-member";
const OUTSIDER_TOKEN = "channel-create-permission-outsider-token";
const OUTSIDER_USER_ID = "channel-create-permission-outsider";

const workerFixture = createFileScopedHubWorker({
  vars: {
    XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
      [OWNER_TOKEN]: {
        id: OWNER_USER_ID,
        email: `${OWNER_USER_ID}@example.com`,
        name: "Channel Create Owner",
      },
      [MEMBER_TOKEN]: {
        id: MEMBER_USER_ID,
        email: `${MEMBER_USER_ID}@example.com`,
        name: "Channel Create Member",
      },
      [OUTSIDER_TOKEN]: {
        id: OUTSIDER_USER_ID,
        email: `${OUTSIDER_USER_ID}@example.com`,
        name: "Channel Create Outsider",
      },
    }),
  },
}, startPgHubWorker);

async function requestJson(worker, token, path, init = {}) {
  return bearerJsonRequest(worker, token, path, init, { trimEmpty: true });
}

async function createSpaceWithMember(worker, name) {
  const created = await requestJson(worker, OWNER_TOKEN, "/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.payload));
  const spaceId = created.payload.space.id;
  await acceptSpaceMembership(worker, requestJson, OWNER_TOKEN, MEMBER_TOKEN, spaceId);
  return spaceId;
}

function createChannel(worker, token, spaceId, name, mode) {
  return requestJson(worker, token, "/api/channels", {
    method: "POST",
    body: JSON.stringify({ spaceId, mode, name }),
  });
}

test("a regular Space member may create open and closed channels", async () => {
  const worker = await workerFixture.get();
  const spaceId = await createSpaceWithMember(worker, "member channel create");

  const open = await createChannel(worker, MEMBER_TOKEN, spaceId, "member-open", "open");
  assert.equal(open.response.status, 200, JSON.stringify(open.payload));

  // Closed create also grants the member creator a projection entitlement in
  // the same transaction; a drifting recipient set would 409 here.
  const closed = await createChannel(worker, MEMBER_TOKEN, spaceId, "member-closed", "closed");
  assert.equal(closed.response.status, 200, JSON.stringify(closed.payload));

  const listed = await requestJson(
    worker,
    MEMBER_TOKEN,
    `/api/channels?spaceId=${encodeURIComponent(spaceId)}`,
  );
  assert.equal(listed.response.status, 200, JSON.stringify(listed.payload));
  const ids = (listed.payload.channels || []).map((channel) => channel.id);
  assert.ok(ids.includes(open.payload.channel.id), "member sees the open channel they created");
  assert.ok(ids.includes(closed.payload.channel.id), "member sees the closed channel they created");
});

test("a non-member still cannot create a channel", async () => {
  const worker = await workerFixture.get();
  const spaceId = await createSpaceWithMember(worker, "outsider channel create");

  const denied = await createChannel(worker, OUTSIDER_TOKEN, spaceId, "outsider-open", "open");
  assert.equal(denied.response.status, 403, JSON.stringify(denied.payload));
});

