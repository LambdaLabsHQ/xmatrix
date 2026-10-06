import {
  createSpace,
  startPgHubWorker as startHubWorker
} from "./agent-launch-postgres.fixture.mjs";
import {
  assert,
  json,
  MOCK_TOKEN,
  postChannelMessage,
  randomUUID,
  test,
} from "./agent-mention-spawn.fixture.mjs";
import { createAuthorityDatabase, PostgresSpaceControlRepository } from "../../db/dist/index.js";

const ADMIN_EMAIL = "platform-admin-e2e@example.com";
const OPERATOR_TOKEN = `operator-${"0123456789abcdef".repeat(4)}`;

function adminWorkerVars(userId, { email = ADMIN_EMAIL, allowlist = ADMIN_EMAIL } = {}) {
  return {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: email,
    XMATRIX_MOCK_AUTH_NAME: "Platform Admin E2E",
    ...(allowlist === null ? {} : { PLATFORM_ADMIN_EMAILS: allowlist }),
  };
}

async function adminFixture(userId, options) {
  const worker = await startHubWorker({ vars: adminWorkerVars(userId, options) });
  const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
  return { worker, auth, jsonAuth: { ...auth, "content-type": "application/json" } };
}

async function assertNotPlatformAdmin(worker, auth) {
  const me = await json(await worker.fetch("/api/auth/me", { headers: auth }));
  assert.equal(me.capabilities.platformAdmin, false);
}

test("platform admin reads a cross-Space overview of spaces, users, and message volume", async () => {
  const userId = `platform-admin-e2e-${randomUUID()}`;
  const { worker, auth, jsonAuth } = await adminFixture(userId);
  try {
    const spaceName = `Admin Overview ${randomUUID()}`;
    const space = await createSpace(worker, spaceName);
    const channel = (await json(await worker.fetch("/api/channels", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ spaceId: space.id, name: `admin-${randomUUID()}`, mode: "open" }),
    }))).channel;
    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "first admin overview message");
    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "second admin overview message");

    const me = await json(await worker.fetch("/api/auth/me", { headers: auth }));
    assert.equal(me.capabilities.platformAdmin, true);

    const { overview } = await json(await worker.fetch(
      "/api/admin/overview?activityDays=7",
      { headers: auth },
    ));

    assert.equal(overview.activityDays, 7);
    assert.equal(overview.activity.length, 7);
    assert.ok(overview.totals.spaces >= 1, "at least the created Space is counted");
    assert.ok(overview.totals.users >= 1, "the member of that Space is counted");
    assert.ok(overview.totals.activeChannels >= 1);
    assert.ok(overview.totals.messages >= 2);
    assert.ok(overview.totals.humanMessages >= 2);

    const summary = overview.spaces.find((entry) => entry.id === space.id);
    assert.equal(summary?.name, spaceName);
    assert.equal(summary?.ownerUserId, userId);
    assert.equal(summary?.members, 1);
    assert.equal(summary?.activeChannels, 1);
    assert.equal(summary?.messages, 2);
    assert.equal(summary?.messagesLast7d, 2);
    assert.ok(summary?.lastMessageAt, "an active Space reports its last message time");

    const user = overview.users.find((entry) => entry.userId === userId);
    assert.ok(user, "the Space member appears in the user table");
    assert.equal(user.messages, 2);
    assert.ok(user.spaces >= 1);

    // Daily volume is a dense oldest-first series that sums to the window total.
    const dailyTotal = overview.activity.reduce((sum, point) => sum + point.messages, 0);
    assert.ok(dailyTotal >= 2);
    assert.deepEqual(
      [...overview.activity].sort((left, right) => left.date.localeCompare(right.date))
        .map((point) => point.date),
      overview.activity.map((point) => point.date),
    );

    // The operator read carries no Channel content.
    const serialized = JSON.stringify(overview);
    assert.equal(serialized.includes("first admin overview message"), false);
    assert.equal(serialized.includes(channel.name), false);
  } finally {
    await worker.stop();
  }
});

test("a signed-in user off the allowlist cannot read the platform overview", async () => {
  const userId = `platform-admin-denied-${randomUUID()}`;
  const worker = await startHubWorker({
    vars: {
      ...adminWorkerVars(userId, {
        email: "not-an-operator@example.com",
        allowlist: `${ADMIN_EMAIL}, other-operator@example.com`,
      }),
      CONTROL_PLANE_OPERATOR_TOKEN: OPERATOR_TOKEN,
    },
  });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    await assertNotPlatformAdmin(worker, auth);

    const response = await worker.fetch("/api/admin/overview", { headers: auth });
    assert.equal(response.status, 403);

    const unauthenticated = await worker.fetch("/api/admin/overview");
    assert.equal(unauthenticated.status, 401);

    // The machine operator token opens only the partition operator routes.
    const operator = await worker.fetch("/api/admin/overview",
      { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
    assert.equal(operator.status, 401);
  } finally {
    await worker.stop();
  }
});

test("an unconfigured allowlist grants the platform overview to nobody", async () => {
  const userId = `platform-admin-unset-${randomUUID()}`;
  const worker = await startHubWorker({
    vars: adminWorkerVars(userId, { allowlist: null }),
  });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    await assertNotPlatformAdmin(worker, auth);
    assert.equal((await worker.fetch("/api/admin/overview", { headers: auth })).status, 403);
  } finally {
    await worker.stop();
  }
});

/**
 * Two mock principals over one Authority, so admin-Space membership can be observed
 * as the only difference between them.
 */
function twoUserWorkerVars(adminUserId, memberUserId, adminSpaceId) {
  return {
    XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
      "admin-space-token": { id: adminUserId, email: "space-admin@example.com", name: "Space Admin" },
      "outsider-token": { id: memberUserId, email: "outsider@example.com", name: "Outsider" },
    }),
    ...(adminSpaceId === null ? {} : { PLATFORM_ADMIN_SPACE_ID: adminSpaceId }),
    ...(adminSpaceId === null ? {} : { TEST_ENVIRONMENT_ACCESS_SPACE_ID: adminSpaceId }),
  };
}

test("membership of the pinned admin Space grants the platform overview", async () => {
  const adminUserId = `platform-admin-space-${randomUUID()}`;
  const outsiderUserId = `platform-outsider-${randomUUID()}`;
  // The deployment pins the admin Space by id before the Space exists.
  const adminSpaceId = `platform-admin-${randomUUID()}`;
  const worker = await startHubWorker({
    vars: twoUserWorkerVars(adminUserId, outsiderUserId, adminSpaceId),
  });
  try {
    const adminAuth = { Authorization: "Bearer admin-space-token" };
    const outsiderAuth = { Authorization: "Bearer outsider-token" };
    const database = createAuthorityDatabase({ connectionString: worker.postgresUrl, shardId: "shard-0" });
    const session = database.openSession();
    try {
      await new PostgresSpaceControlRepository(session, "shard-0").createSpace({
        requestId: "admin-space", commandId: "admin-space", spaceId: adminSpaceId,
        ownerUserId: adminUserId, name: "Platform admins",
      });
    } finally { await session.close(); }
    await createSpace(worker, "Outsider's own", "outsider-token");

    const adminMe = await json(await worker.fetch("/api/auth/me", { headers: adminAuth }));
    assert.equal(adminMe.capabilities.platformAdmin, true);
    assert.equal(adminMe.capabilities.testEnvironment, true);
    const { overview } = await json(await worker.fetch("/api/admin/overview", { headers: adminAuth }));
    assert.ok(overview.totals.users >= 2, "both principals are counted");

    // Membership of some other Space is not membership of the admin Space.
    const outsiderMe = await json(await worker.fetch("/api/auth/me", { headers: outsiderAuth }));
    assert.equal(outsiderMe.capabilities.platformAdmin, false);
    assert.equal(outsiderMe.capabilities.testEnvironment, false);
    assert.equal((await worker.fetch("/api/admin/overview", { headers: outsiderAuth })).status, 403);
  } finally {
    await worker.stop();
  }
});

test("a pinned admin Space that does not exist grants nothing", async () => {
  const adminUserId = `platform-admin-missing-space-${randomUUID()}`;
  const outsiderUserId = `platform-outsider-${randomUUID()}`;
  const worker = await startHubWorker({
    vars: twoUserWorkerVars(adminUserId, outsiderUserId, `space:absent-${randomUUID()}`),
  });
  try {
    const adminAuth = { Authorization: "Bearer admin-space-token" };
    await json(await worker.fetch("/api/spaces", { headers: adminAuth }));

    const me = await json(await worker.fetch("/api/auth/me", { headers: adminAuth }));
    assert.equal(me.capabilities.platformAdmin, false);
    assert.equal(me.capabilities.testEnvironment, false);
    assert.equal((await worker.fetch("/api/admin/overview", { headers: adminAuth })).status, 403);
  } finally {
    await worker.stop();
  }
});
