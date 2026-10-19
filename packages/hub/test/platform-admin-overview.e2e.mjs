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
import { Client } from "pg";

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

async function createOpenChannel(worker, jsonAuth, spaceId, prefix) {
  return (await json(await worker.fetch("/api/channels", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ spaceId, name: `${prefix}-${randomUUID()}`, mode: "open" }),
  }))).channel;
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
    const channel = await createOpenChannel(worker, jsonAuth, space.id, "admin");
    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "first admin overview message");
    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "second admin overview message");

    const lastAgentMessageAt = new Date(Date.now() + 1_000).toISOString();
    const later = new Date(Date.now() + 2_000).toISOString();
    const client = new Client({ connectionString: worker.postgresUrl });
    await client.connect();
    try {
      // Send-time ownership must survive an absent Instance and must not be
      // inferred from a display name, another owner's Agent, or system traffic.
      for (const [index, [kind, owner, at, deleted]] of [
        ["agent", userId, lastAgentMessageAt, false],
        ["agent", "another-user", later, false],
        ["agent", null, later, false],
        ["system", userId, later, false],
        ["agent", userId, later, true],
      ].entries()) {
        await client.query(`INSERT INTO data.messages SELECT (jsonb_populate_record(
          NULL::data.messages, to_jsonb(source) || jsonb_build_object(
            'message_id', $2::text, 'author_kind', $3::text, 'author_id', $4::text,
            'timeline_sequence', $5::bigint, 'search_rank_sequence', 'admin-agent:' || $2::text,
            'created_at', $6::timestamptz,
            'updated_at', $6::timestamptz, 'sent_at', $6::timestamptz,
            'deleted_at', CASE WHEN $7::boolean THEN $6::timestamptz ELSE NULL END,
            'preview_json', jsonb_build_object('bodyPreview', 'private agent message',
              'senderSnapshot', jsonb_build_object('kind', $3::text, 'userId', $8::text,
                'name', 'same-display-name'))))).*
          FROM data.messages source WHERE channel_id = $1 AND author_kind = 'user' LIMIT 1`,
        [channel.id, randomUUID(), kind, `instance:${randomUUID()}`, 10_000 + index,
        at, deleted, owner]);
      }
      await client.query(`INSERT INTO data.machine_daemons
        (daemon_id, owner_user_id, owner_email, machine_id, hostname, status,
         capabilities_json, metadata_json, connection_epoch, version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'private-admin-machine-host', 'online',
         '[]', '{"private":"must-not-appear"}', 1, 1, now(), now())`,
      [`daemon:${userId}`, userId, ADMIN_EMAIL, `machine:${userId}`]);
    } finally { await client.end(); }

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
    assert.equal(overview.totals.machines, 1);
    assert.equal(overview.totals.onlineMachines, 1);

    const summary = overview.spaces.find((entry) => entry.id === space.id);
    assert.equal(summary?.name, spaceName);
    assert.equal(summary?.ownerUserId, userId);
    assert.equal(summary?.members, 1);
    assert.equal(summary?.activeChannels, 1);
    assert.equal(summary?.messages, 6);
    assert.equal(summary?.messagesLast7d, 6);
    assert.ok(summary?.lastMessageAt, "an active Space reports its last message time");

    const user = overview.users.find((entry) => entry.userId === userId);
    assert.ok(user, "the Space member appears in the user table");
    assert.equal(user.messages, 2);
    assert.equal(user.machines, 1);
    assert.ok(user.spaces >= 1);

    assert.equal(user.lastMessageAt, lastAgentMessageAt,
      "the owner's Agent advances activity, with foreign/system/deleted/unattributed messages excluded");
    const { detail } = await json(await worker.fetch(
      `/api/admin/users/${encodeURIComponent(userId)}`, { headers: auth },
    ));
    assert.equal(detail.user.lastMessageAt, lastAgentMessageAt);
    assert.equal(detail.messages.lastMessageAt, lastAgentMessageAt);
    assert.equal(detail.messages.total, 2, "message counts remain user-authored");

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
    assert.equal(serialized.includes("private agent message"), false);
    assert.equal(serialized.includes("same-display-name"), false);
    assert.equal(serialized.includes("private-admin-machine-host"), false);
    assert.equal(serialized.includes("must-not-appear"), false);
  } finally {
    await worker.stop();
  }
});

test("platform admin reads one user's metadata-only detail, and every read is audited", async () => {
  const userId = `platform-admin-detail-${randomUUID()}`;
  const { worker, auth, jsonAuth } = await adminFixture(userId);
  try {
    const spaceName = `Admin Detail ${randomUUID()}`;
    const space = await createSpace(worker, spaceName);
    const channel = await createOpenChannel(worker, jsonAuth, space.id, "detail");
    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "private detail message");

    // The owning read must aggregate real execution/message metadata without
    // mixing Spaces/providers or counting action receipts as incoming events.
    const otherSpace = await createSpace(worker, `Other ${randomUUID()}`);
    const client = new Client({ connectionString: worker.postgresUrl });
    await client.connect();
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    try {
      for (const [sid, provider, creator] of [
        [space.id, "github", userId], [space.id, "notion", userId], [space.id, "slack", "other-user"],
        [otherSpace.id, "github", "other-user"],
      ]) {
        await client.query(`INSERT INTO data.app_connector_connections
          (connection_id, space_id, provider_id, provider_name, status, auth_mode,
           scopes_json, secret_refs_json, capabilities_json, channel_ids_json,
           created_by, metadata_json, search_rank_sequence, version, created_at, updated_at)
          VALUES ($1,$2,$3,$3,'configured','oauth','[]','[]','[]','[]',$4,
            '{"private":"connector-private"}',$1,1,$5,$5)`,
        [`${sid}:${provider}`, sid, provider, creator, recent]);
      }
      const cases = [
        [space.id, "github", "completed", old],
        ...["queued", "completed", "failed", "blocked", "planned"].map(status => [space.id, "github", status, recent]),
        [space.id, "slack", "completed", recent], [otherSpace.id, "github", "completed", recent],
      ];
      for (const [sid, provider, status, at] of cases) {
        await client.query(`INSERT INTO data.app_connector_executions
          (execution_id,space_id,channel_id,message_id,provider_id,provider_name,status,
           connection_id,requested_by,reason,result_summary,version,created_at,updated_at)
          VALUES ($1,$2,$3,$1,$4,$4,$5,$6,'another-caller','private-error','private-result',1,$7,$7)`,
        [randomUUID(), sid, channel.id, provider, status, `${sid}:${provider}`, at]);
      }
      await client.query(`INSERT INTO data.app_source_relations
        (relation_id,connection_id,space_id,channel_id,source_kind,source_ref,features_json,version,created_by,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'repository','github:private/repo','[]',1,$5,$6,$6)`,
      [randomUUID(), `${space.id}:github`, space.id, channel.id, userId, recent]);
      for (const [index, [sid, provider, id, at, deleted]] of [
        [space.id, "github", "app:github:old", old, false],
        [space.id, "github", "app:github:delivery:one", recent, false],
        [space.id, "github", "app:github:delivery:two", recent, false],
        [space.id, "github", "app:github:deleted", recent, true],
        [space.id, "github", "system:command:github", recent, false],
        [space.id, "slack", "app:slack:delivery", recent, false],
        [otherSpace.id, "github", "app:github:foreign", recent, false],
      ].entries()) {
        const insert = `INSERT INTO data.messages SELECT (jsonb_populate_record(
          NULL::data.messages, to_jsonb(source) || jsonb_build_object(
            'space_id', $2::text, 'message_id', $3::text, 'author_kind', 'app', 'author_id', $4::text,
            'timeline_sequence', $5::bigint, 'search_rank_sequence', $3::text,
            'created_at', $6::timestamptz, 'updated_at', $6::timestamptz, 'sent_at', $6::timestamptz,
            'deleted_at', CASE WHEN $7::boolean THEN $6::timestamptz ELSE NULL END))).*
          FROM data.messages source WHERE channel_id = $1 AND author_kind = 'user' LIMIT 1
          ON CONFLICT DO NOTHING`;
        const values = [channel.id, sid, id, provider, 20_000 + index, at, deleted];
        await client.query(insert, values);
        await client.query(insert, values); // Provider retry cannot inflate the retained delivery count.
      }
    } finally { await client.end(); }

    const { detail } = await json(await worker.fetch(
      `/api/admin/users/${encodeURIComponent(userId)}`,
      { headers: auth },
    ));
    assert.equal(detail.user.userId, userId);
    const membership = detail.spaces.find((entry) => entry.spaceId === space.id);
    assert.equal(membership?.name, spaceName);
    assert.equal(membership?.role, "owner");
    assert.equal(membership?.messages, 1);
    assert.ok(detail.messages.total >= 1);
    assert.equal(detail.activity.length, 30);
    assert.equal(detail.activity.at(-1).messages >= 1, true);
    assert.deepEqual(detail.connectors.map(c => c.providerId), ["github", "notion"],
      "only this user's added connections appear, including an idle connection");
    assert.deepEqual(detail.connectors[0].usage, {
      requests: 6, requestsLast30d: 5,
      byStatus: { queued: 1, completed: 2, failed: 1, blocked: 1, planned: 1 },
      lastRequestAt: recent, eventDeliveries: 3, eventDeliveriesLast30d: 2,
      lastEventAt: recent, subscribedChannels: 1, subscriptions: 1,
    });
    assert.deepEqual(detail.connectors[1].usage, {
      requests: 0, requestsLast30d: 0,
      byStatus: { queued: 0, completed: 0, failed: 0, blocked: 0, planned: 0 },
      eventDeliveries: 0, eventDeliveriesLast30d: 0, subscribedChannels: 0, subscriptions: 0,
    });

    // Metadata only: no message text, no Channel name.
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes("private detail message"), false);
    assert.equal(serialized.includes(channel.name), false);
    for (const content of ["connector-private", "private-error", "private-result", "github:private/repo"]) {
      assert.equal(serialized.includes(content), false, "connector content must stay private");
    }

    assert.equal((await worker.fetch(
      `/api/admin/users/${encodeURIComponent(`absent-${randomUUID()}`)}`,
      { headers: auth },
    )).status, 404);

    const { events } = await json(await worker.fetch("/api/admin/audit?limit=20", { headers: auth }));
    const userRead = events.find((event) => event.action === "user.read" && event.targetId === userId);
    assert.ok(userRead, "the detail read is in the audit trail");
    assert.equal(userRead.actorUserId, userId);
    assert.equal(userRead.targetKind, "user");
    assert.equal(events[0].action, "audit.read", "reading the trail is itself recorded first");
  } finally {
    await worker.stop();
  }
});

test("platform admin reads one Space's metadata-only detail and platform operations, audited", async () => {
  const userId = `platform-admin-space-${randomUUID()}`;
  const { worker, auth, jsonAuth } = await adminFixture(userId);
  try {
    const spaceName = `Admin Space ${randomUUID()}`;
    const space = await createSpace(worker, spaceName);
    const channel = await createOpenChannel(worker, jsonAuth, space.id, "space-detail");
    await postChannelMessage(worker, MOCK_TOKEN, channel.id, "private space message");

    const { detail } = await json(await worker.fetch(
      `/api/admin/spaces/${encodeURIComponent(space.id)}`, { headers: auth }));
    assert.equal(detail.space.spaceId, space.id);
    assert.equal(detail.space.name, spaceName);
    assert.equal(detail.space.ownerUserId, userId);
    assert.equal(detail.totals.members, 1);
    assert.ok(detail.totals.channels >= 1);
    assert.equal(detail.totals.messages >= 1, true);
    assert.equal(detail.members[0].userId, userId);
    assert.equal(detail.members[0].role, "owner");
    assert.equal(detail.members[0].messages, 1);
    assert.equal(detail.activity.length, 30);
    assert.equal(detail.activity.at(-1).humanMessages >= 1, true);
    assert.deepEqual(detail.truncated, []);
    const serializedDetail = JSON.stringify(detail);
    assert.equal(serializedDetail.includes("private space message"), false);
    assert.equal(serializedDetail.includes(channel.name), false);

    assert.equal((await worker.fetch(
      `/api/admin/spaces/${encodeURIComponent(`absent-${randomUUID()}`)}`, { headers: auth })).status, 404);

    const { operations } = await json(await worker.fetch("/api/admin/operations", { headers: auth }));
    assert.equal(operations.days, 30);
    assert.equal(operations.runs.daily.length, 30);
    assert.equal(typeof operations.outbox.byStatus, "object");
    assert.ok(Array.isArray(operations.machines));
    assert.ok(Array.isArray(operations.billing.subscriptions));
    assert.equal(JSON.stringify(operations).includes("private space message"), false);

    const { events } = await json(await worker.fetch("/api/admin/audit?limit=20", { headers: auth }));
    const spaceRead = events.find((event) => event.action === "space.read" && event.targetId === space.id);
    assert.ok(spaceRead, "the Space read is in the audit trail");
    assert.equal(spaceRead.targetKind, "space");
    assert.ok(events.some((event) => event.action === "operations.read"), "the operations read is audited");
  } finally {
    await worker.stop();
  }
});

test("admin reads fail closed when their audit record cannot be written", async () => {
  const userId = `platform-admin-audit-failure-${randomUUID()}`;
  const { worker, auth } = await adminFixture(userId);
  try {
    await createSpace(worker, "Audit failure fixture");
    // Only this worker's disposable database is changed; the test template
    // and other workers retain their audit table.
    const client = new Client({ connectionString: worker.postgresUrl });
    await client.connect();
    try {
      await client.query("ALTER TABLE control.admin_audit_events RENAME TO unavailable_admin_audit_events");
    } finally { await client.end(); }
    for (const route of ["/api/admin/overview", `/api/admin/users/${userId}`, "/api/admin/audit",
      "/api/admin/spaces/any-space", "/api/admin/operations"]) {
      const response = await worker.fetch(route, { headers: auth });
      assert.equal(response.status, 500, `${route} must refuse an unaudited read`);
      const body = await response.json();
      assert.equal(body.overview, undefined);
      assert.equal(body.detail, undefined);
      assert.equal(body.events, undefined);
      assert.equal(body.operations, undefined);
    }
  } finally { await worker.stop(); }
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
    assert.equal((await worker.fetch(`/api/admin/users/${userId}`, { headers: auth })).status, 403);
    assert.equal((await worker.fetch("/api/admin/audit", { headers: auth })).status, 403);
    assert.equal((await worker.fetch("/api/admin/spaces/any-space", { headers: auth })).status, 403);
    assert.equal((await worker.fetch("/api/admin/operations", { headers: auth })).status, 403);

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
