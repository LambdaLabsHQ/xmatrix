import assert from "node:assert/strict";
import { connectorDatabase, integration, connectorSubscriptionChannel } from "./postgres-database.fixture.mjs";
import { PostgresGoogleChatRoomRepository, PostgresAppCredentialRepository, PostgresAppRepository, googleChatAppIdentity } from "../dist/index.js";

async function fixture(run) {
  const { client, database, sql } = await connectorDatabase("googlechat-room-test");
  const prefix = "chat-test-" + crypto.randomUUID();
  const spaces = [prefix + "-a", prefix + "-b"];
  const appId = String(Date.now()) + String(Math.floor(Math.random() * 1000000));
  const app = { appId, systemServiceAccountEmail: "service-" + appId + "@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
    serviceAccountEmail: "fixture@app-project.iam.gserviceaccount.com" };
  const repo = new PostgresGoogleChatRoomRepository(database);
  const apps = new PostgresAppRepository(database);
  const credentials = new PostgresAppCredentialRepository(database, "googlechat-test-material");
  const chatSpace = "spaces/AbC-opaque";
  const request = extra => ({ requestId: crypto.randomUUID(), app, ...extra });
  const begin = (index = 0, extra = {}) => repo.begin(request({ spaceId: spaces[index], actorUserId: "owner", chatSpace, ...extra }));
  const time = async () => (await database.transaction({ requestId: crypto.randomUUID(), operation: "chat-test.clock" },
    tx => tx.query({ name: "chat_test_clock_v1", text: "SELECT clock_timestamp() AS at", maxRows: 1 })))[0].at.toISOString();
  const confirm = async (attempt, extra = {}) => repo.confirm(request({ chatSpace, nonce: attempt.nonce, eventTime: await time(), ...extra }));
  const resolve = (index = 0, extra = {}) => repo.resolve(request({ spaceId: spaces[index], ...extra }));
  const current = binding => repo.current(request({ binding }));
  const remove = async (extra = {}) => repo.remove(request({ chatSpace, eventTime: await time(), ...extra }));
  const route = async (extra = {}) => repo.route(request({ chatSpace, eventTime: await time(), ...extra }));
  try {
    for (const space of spaces) {
      await sql(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
        VALUES ($1,'owner','owner',1,now(),now()),($1,'member','member',1,now(),now())`, [space]);
      await sql(`INSERT INTO data.app_connector_connections
        (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
         capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
        VALUES ($1,$1||':googlechat',1,'googlechat','Google Chat','disconnected','api-token','[]','[]','[]','[]',
          'owner',$1||':generation',now(),now())`, [space]);
    }
    await run({ repo, database, sql, app, spaces, chatSpace, request, begin, time, confirm, resolve, current, remove, route, credentials, apps });
  } finally {
    await sql("DELETE FROM data.app_googlechat_room_lifecycle WHERE app_identity=$1", [googleChatAppIdentity(app)]);
    for (const table of ["app_source_relations", "channels", "app_connector_connections", "space_deletions", "space_members"]) {
      for (const space of spaces) await sql("DELETE FROM data." + table + " WHERE space_id=$1", [space]);
    }
    await database.close?.();
    await client.end();
  }
}
const invalid = error => error.status === 409;

integration("Chat challenges are private digests, room-bound, expiring, and cannot activate by mere initiation", async () => {
  await fixture(async ({ sql, spaces, begin, resolve, confirm }) => {
    const attempt = await begin();
    assert.match(attempt.nonce, /^[A-Za-z0-9_-]{32}$/);
    const row = (await sql("SELECT * FROM data.app_googlechat_link_attempts WHERE space_id=$1", [spaces[0]])).rows[0];
    assert.doesNotMatch(JSON.stringify(row), new RegExp(attempt.nonce));
    assert.equal(row.expires_at - row.started_at, 180000);
    assert.equal(await resolve(), null);
    await assert.rejects(confirm(attempt, { chatSpace: "spaces/Other" }), invalid);
    await assert.rejects(confirm(attempt, { nonce: "x".repeat(32) }), invalid);
    const bound = await confirm(attempt);
    assert.equal(bound.chatSpace, "spaces/AbC-opaque");
    assert.equal((await resolve()).grantGeneration, bound.grantGeneration);
    assert.equal((await sql("SELECT status FROM data.app_connector_connections WHERE space_id=$1", [spaces[0]])).rows[0].status, "configured");
  });
});
integration("Chat challenge initiation and confirmation both require the current Human admin role", async () => {
  await fixture(async ({ sql, spaces, begin, confirm }) => {
    await assert.rejects(begin(0, { actorUserId: "member" }), error => error.status === 404);
    const attempt = await begin();
    await sql("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id='owner'", [spaces[0]]);
    await assert.rejects(confirm(attempt), error => error.status === 404);
    assert.equal((await sql("SELECT count(*) FROM data.app_googlechat_room_bindings WHERE space_id=$1", [spaces[0]])).rows[0].count, "0");
  });
});
integration("Chat expired, replaced and already-consumed confirmations cannot reconnect", async () => {
  await fixture(async ({ sql, spaces, begin, confirm, resolve }) => {
    const expired = await begin();
    await sql(`UPDATE data.app_googlechat_link_attempts SET
      started_at=statement_timestamp()-interval '4 minutes',expires_at=statement_timestamp()-interval '1 minute'
      WHERE space_id=$1`, [spaces[0]]);
    await assert.rejects(confirm(expired), invalid);
    const old = await begin(), latest = await begin();
    await assert.rejects(confirm(old), invalid);
    const bound = await confirm(latest);
    await assert.rejects(confirm(latest), invalid);
    assert.equal((await resolve()).grantGeneration, bound.grantGeneration);
  });
});
integration("Parallel Chat confirmation admits exactly one grant and one connection revision", async () => {
  await fixture(async ({ sql, spaces, begin, confirm }) => {
    const attempt = await begin();
    const results = await Promise.allSettled([confirm(attempt), confirm(attempt), confirm(attempt)]);
    assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
    assert.ok(results.filter(value => value.status === "rejected").every(value => invalid(value.reason)));
    assert.equal((await sql("SELECT version FROM data.app_connector_connections WHERE space_id=$1", [spaces[0]])).rows[0].version, "2");
  });
});
integration("A Chat room cannot be captured by a second xMatrix Space, including simultaneous pending challenges", async () => {
  await fixture(async ({ spaces, begin, confirm, resolve }) => {
    const first = await begin(0), second = await begin(1);
    const results = await Promise.allSettled([confirm(first), confirm(second)]);
    assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
    const bound = results.find(value => value.status === "fulfilled").value;
    assert.ok(spaces.includes(bound.spaceId));
    assert.equal(await resolve(bound.spaceId === spaces[0] ? 1 : 0), null);
    await assert.rejects(begin(bound.spaceId === spaces[0] ? 1 : 0), invalid);
  });
});
integration("Chat challenge snapshots fence credential edits, connection edits and delete/recreate ABA", async () => {
  await fixture(async ({ sql, spaces, begin, confirm }) => {
    const connection = spaces[0] + ":googlechat";
    let attempt = await begin();
    await sql("UPDATE data.app_connector_connections SET version=version+1 WHERE connection_id=$1", [connection]);
    await assert.rejects(confirm(attempt), invalid);
    attempt = await begin();
    await sql(`INSERT INTO data.app_connector_credentials
      (connection_id,space_id,field_names_json,encrypted_value_json,version,updated_by,created_at,updated_at)
      VALUES ($1,$2,'[]','{}',1,'owner',now(),now())`, [connection, spaces[0]]);
    await assert.rejects(confirm(attempt), invalid);
    await sql("DELETE FROM data.app_connector_credentials WHERE connection_id=$1", [connection]);
    attempt = await begin();
    await sql("UPDATE data.app_connector_connections SET search_rank_sequence=search_rank_sequence||'-replacement' WHERE connection_id=$1", [connection]);
    await assert.rejects(confirm(attempt), invalid);
    await sql("DELETE FROM data.app_connector_connections WHERE connection_id=$1", [connection]);
    await assert.rejects(confirm(attempt), invalid);
    assert.equal((await sql("SELECT count(*) FROM data.app_googlechat_link_attempts WHERE space_id=$1", [spaces[0]])).rows[0].count, "0");
  });
});
integration("Chat reconnect preserves the old grant until confirmation and then fences captured old work", async () => {
  await fixture(async ({ begin, confirm, resolve, current }) => {
    const old = await confirm(await begin());
    const attempt = await begin(0, { chatSpace: "spaces/New-room" });
    assert.equal((await resolve()).chatSpace, old.chatSpace);
    assert.equal(await current(old), true);
    const fresh = await confirm(attempt, { chatSpace: "spaces/New-room" });
    assert.notEqual(fresh.grantGeneration, old.grantGeneration);
    assert.equal(await current(old), false);
    assert.equal(await current(fresh), true);
  });
});
integration("Chat removal invalidates current and pending grants; stale removal cannot retire a new link", async () => {
  await fixture(async ({ begin, confirm, remove, route, current, resolve, time }) => {
    const old = await confirm(await begin());
    const removalTime = await time();
    await remove({ eventTime: removalTime });
    assert.equal(await current(old), false);
    assert.equal(await route(), null);
    await assert.rejects(resolve(), invalid);
    const fresh = await confirm(await begin());
    await remove({ eventTime: removalTime });
    assert.equal(await current(fresh), true);
    const pending = await begin();
    await remove();
    await assert.rejects(confirm(pending), invalid);
  });
});
integration("Chat routing checks app identity, exact opaque case, event time and live Space deletion", async () => {
  await fixture(async ({ sql, spaces, app, begin, confirm, route, resolve, current }) => {
    const bound = await confirm(await begin());
    assert.equal((await route()).connectionId, bound.connectionId);
    assert.equal(await route({ chatSpace: "spaces/abc-opaque" }), null);
    assert.equal(await route({ eventTime: new Date(Date.now() - 3600000).toISOString() }), null);
    assert.equal(await route({ eventTime: new Date(Date.now() + 60000).toISOString() }), null);
    const other = { ...app, serviceAccountEmail: "another@app-project.iam.gserviceaccount.com" };
    await assert.rejects(resolve(0, { app: other }), error => error.status === 503);
    await sql(`INSERT INTO data.space_deletions (space_id,space_name,owner_user_id,requested_at,purge_after,
      updated_at,state,purge_started_at,completed_at,version)
      VALUES ($1,'Chat test','owner',now()-interval '1 day',now(),now(),'completed',now(),now(),1)`, [spaces[0]]);
    assert.equal(await route(), null);
    assert.equal(await current(bound), false);
    await assert.rejects(begin(), error => error.status === 404);
  });
});
integration("Chat native confirmation replaces manual credentials; explicit later credential editing replaces native mode", async () => {
  await fixture(async ({ spaces, credentials, begin, confirm, resolve, current, sql }) => {
    const put = fields => credentials.put({ requestId: crypto.randomUUID(), spaceId: spaces[0], providerId: "googlechat",
      actorUserId: "owner", fields, policy: { allowed: ["webhookUrl"] }, at: new Date().toISOString() });
    await put({ webhookUrl: "https://chat.googleapis.com/v1/spaces/fixture/messages?key=fixture" });
    const bound = await confirm(await begin());
    assert.equal((await sql("SELECT count(*) FROM data.app_connector_credentials WHERE space_id=$1", [spaces[0]])).rows[0].count, "0");
    const pending = await begin();
    await put({ webhookUrl: "https://chat.googleapis.com/v1/spaces/other/messages?key=fixture" });
    assert.equal(await current(bound), false);
    assert.equal(await resolve(), null);
    await assert.rejects(confirm(pending), invalid);
  });
});
integration("Chat connection error is readable only for Check; disconnected rooms and fabricated generations cannot authorize writes", async () => {
  await fixture(async ({ sql, spaces, begin, confirm, resolve, current }) => {
    const bound = await confirm(await begin());
    await sql("UPDATE data.app_connector_connections SET status='error' WHERE space_id=$1", [spaces[0]]);
    await assert.rejects(resolve(), invalid);
    assert.equal((await resolve(0, { forCheck: true })).grantGeneration, bound.grantGeneration);
    assert.equal(await current(bound), false);
    await sql("UPDATE data.app_connector_connections SET status='disconnected' WHERE space_id=$1", [spaces[0]]);
    await assert.rejects(resolve(0, { forCheck: true }), invalid);
    assert.equal(await current({ ...bound, grantGeneration: crypto.randomUUID() }), false);
  });
});

integration("Chat expiry maintenance is bounded and cannot change a live grant or revive retired authority", async () => {
  await fixture(async ({ repo, sql, spaces, app, begin, confirm, current }) => {
    const bound = await confirm(await begin());
    const pending = await begin(1, { chatSpace: "spaces/Another" });
    await sql(`UPDATE data.app_googlechat_link_attempts SET started_at=statement_timestamp()-interval '4 minutes',
      expires_at=statement_timestamp()-interval '1 minute' WHERE space_id=$1`, [spaces[1]]);
    const identity = googleChatAppIdentity(app);
    await sql(`INSERT INTO data.app_googlechat_room_lifecycle(app_identity,chat_space,removed_at)
      VALUES ($1,'spaces/OldA',now()-interval '2 days'),($1,'spaces/OldB',now()-interval '2 days'),
        ($1,'spaces/Fresh',now())`, [identity]);
    await repo.cleanup({ requestId: crypto.randomUUID(), limit: 1 });
    assert.equal((await sql("SELECT count(*) FROM data.app_googlechat_link_attempts WHERE space_id=$1", [spaces[1]])).rows[0].count, "0");
    assert.equal((await sql("SELECT count(*) FROM data.app_googlechat_room_lifecycle WHERE app_identity=$1", [identity])).rows[0].count, "2");
    assert.equal(await current(bound), true);
    await assert.rejects(repo.confirm({ requestId: crypto.randomUUID(), app, chatSpace: "spaces/Another", nonce: pending.nonce,
      eventTime: new Date().toISOString() }), invalid);
    for (const limit of [0, -1, 257, 1.5]) await assert.rejects(repo.cleanup({ requestId: crypto.randomUUID(), limit }),
      error => error.status === 400);
  });
});

integration("Chat Channel delivery requires the exact live room grant and bounds fanout before any partial result", async () => {
  await fixture(async ({ apps, sql, spaces, app, begin, confirm, remove, credentials }) => {
    const addChannel = (space, index) => connectorSubscriptionChannel(sql, space, index, "googlechat");
    const channel = await addChannel(spaces[0], 1);
    await addChannel(spaces[1], 1);
    let bound = await confirm(await begin());
    const routes = (binding = bound, extra = {}) => apps.connectorEventRoutes({ requestId: crypto.randomUUID(),
      connectionId: binding.connectionId, sourceRef: "googlechat:*", limit: 2,
      googleChatBinding: { appIdentity: googleChatAppIdentity(app), chatSpace: binding.chatSpace,
        grantGeneration: binding.grantGeneration }, ...extra });
    assert.deepEqual((await routes()).map(row => row.channelId), [channel]);
    assert.deepEqual(await routes(bound, { sourceRef: "googlechat:room-other" }), []);
    assert.deepEqual(await routes({ ...bound, chatSpace: "spaces/abc-opaque" }), []);
    assert.deepEqual(await routes({ ...bound, grantGeneration: crypto.randomUUID() }), []);
    assert.deepEqual(await routes(bound, { connectionId: spaces[1] + ":googlechat" }), []);
    const old = bound;
    bound = await confirm(await begin());
    assert.deepEqual(await routes(old), []);
    assert.deepEqual((await routes()).map(row => row.channelId), [channel]);
    await addChannel(spaces[0], 2);
    await addChannel(spaces[0], 3);
    await assert.rejects(routes(), error => error.status === 503);
    await remove();
    assert.deepEqual(await routes(), []);
    bound = await confirm(await begin());
    await credentials.put({ requestId: crypto.randomUUID(), spaceId: spaces[0], providerId: "googlechat",
      actorUserId: "owner", fields: { webhookUrl: "https://chat.googleapis.com/v1/spaces/fixture/messages?key=fixture" },
      policy: { allowed: ["webhookUrl"] }, at: new Date().toISOString() });
    assert.deepEqual(await routes(), []);
  });
});
