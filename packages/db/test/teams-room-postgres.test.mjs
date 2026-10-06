import assert from "node:assert/strict";
import { connectorDatabase, integration, connectorSubscriptionChannel } from "./postgres-database.fixture.mjs";
import { PostgresTeamsRoomRepository, PostgresAppCredentialRepository, PostgresAppRepository, teamsRoomId, teamsAppIdentity } from "../dist/index.js";
import { teamsApp, teamsReference as reference } from "../../hub/test/support/teams-fixture.mjs";

async function fixture(work) {
  const { client, database, sql } = await connectorDatabase("teams-boundary-test");
  const spaces = [crypto.randomUUID(), crypto.randomUUID()];
  const app = { ...teamsApp, appId: crypto.randomUUID() };
  const repo = new PostgresTeamsRoomRepository(database);
  const room = await teamsRoomId(reference);
  const input = fields => ({ requestId: crypto.randomUUID(), app, ...fields });
  const time = async () => (await sql("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
  const start = (index = 0, extra = {}) => repo.begin(input({ spaceId: spaces[index], actorUserId: "owner", chatSpace: "pending", ...extra }));
  const confirm = async (attempt, extra = {}) => repo.confirm(input({ chatSpace: room, nonce: attempt.nonce, eventTime: await time(), teamsReference: reference, ...extra }));
  const resolve = (index = 0) => repo.resolve(input({ spaceId: spaces[index] }));
  const remove = async () => repo.remove(input({ chatSpace: room, eventTime: await time() }));
  try {
    for (const space of spaces) {
      await sql("INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at) VALUES ($1,'owner','owner',1,now(),now())", [space]);
      await sql(`INSERT INTO data.app_connector_connections (connection_id,space_id,provider_id,provider_name,status,auth_mode,
        scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,version,search_rank_sequence,created_at,updated_at)
        VALUES ($1||':teams',$1,'teams','Microsoft Teams','disconnected','api-token','[]','[]','[]','[]','owner',1,$1,now(),now())`, [space]);
    }
    await work({ repo, app, room, spaces, sql, input, time, start, confirm, resolve, remove,
      apps: new PostgresAppRepository(database), credentials: new PostgresAppCredentialRepository(database, "teams-fixture-material") });
  } finally {
    await sql("DELETE FROM data.app_teams_room_lifecycle WHERE app_identity=$1", [teamsAppIdentity(app)]);
    for (const table of ["app_source_relations", "channels", "app_connector_connections"]) {
      await sql("DELETE FROM data." + table + " WHERE space_id=ANY($1)", [spaces]);
    }
    await sql("DELETE FROM data.space_members WHERE space_id=ANY($1)", [spaces]);
    await database.close?.(); await client.end();
  }
}
const changed = error => error.status === 409;

integration("Teams captures only Microsoft-authenticated reference, consumes one nonce, rejects tenant and room tampering", async () => {
  await fixture(async f => {
    const attempt = await f.start();
    assert.equal(await f.resolve(), null);
    const persisted = (await f.sql("SELECT * FROM data.app_teams_link_attempts WHERE space_id=$1", [f.spaces[0]])).rows[0];
    assert.equal(persisted.chat_space, "pending"); assert.notEqual(persisted.nonce_digest, attempt.nonce);
    await assert.rejects(f.confirm(attempt, { teamsReference: { ...reference, tenantId: crypto.randomUUID() } }));
    await assert.rejects(f.confirm(attempt, { chatSpace: "room-" + "a".repeat(64) }), changed);
    const grant = await f.confirm(attempt);
    assert.deepEqual(grant.teamsReference, reference);
    assert.equal((await f.resolve()).grantGeneration, grant.grantGeneration);
    await assert.rejects(f.confirm(attempt), changed);
  });
});

integration("Teams current Human admin, connection version, credential mode and three-minute expiry gate confirmation", async () => {
  await fixture(async f => {
    const attempt = await f.start();
    await f.sql("UPDATE data.space_members SET role='member' WHERE space_id=$1", [f.spaces[0]]);
    await assert.rejects(f.confirm(attempt), error => error.status === 404);
    await assert.rejects(f.start(), error => error.status === 404);
    await f.sql("UPDATE data.space_members SET role='owner' WHERE space_id=$1", [f.spaces[0]]);
    await f.sql("UPDATE data.app_connector_connections SET version=version+1 WHERE space_id=$1", [f.spaces[0]]);
    await assert.rejects(f.confirm(attempt), changed);
    const expired = await f.start();
    await f.sql(`UPDATE data.app_teams_link_attempts SET started_at=statement_timestamp()-interval '4 minutes',
      expires_at=statement_timestamp()-interval '1 minute' WHERE space_id=$1`, [f.spaces[0]]);
    await assert.rejects(f.confirm(expired), changed);
  });
});

integration("Concurrent Teams nonce consumption and competing Spaces admit only one grant", async () => {
  await fixture(async f => {
    const attempt = await f.start();
    const results = await Promise.allSettled([f.confirm(attempt), f.confirm(attempt), f.confirm(attempt)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.ok(results.filter(result => result.status === "rejected").every(result => changed(result.reason)));
    const second = await f.start(1);
    await assert.rejects(f.confirm(second), changed);
    assert.equal(await f.resolve(1), null);
  });
});

integration("Teams removal before first confirmation fences pending wildcard attempts and concurrent removal cannot resurrect a grant", async () => {
  await fixture(async f => {
    const pending = await f.start();
    await f.remove();
    await assert.rejects(f.confirm(pending), changed);
    const reconnect = await f.start();
    const bound = await f.confirm(reconnect);
    await f.remove();
    assert.equal(await f.repo.current(f.input({ binding: bound })), false);
    await assert.rejects(f.resolve(), changed);
    const another = await f.start();
    await Promise.allSettled([f.confirm(another), f.remove()]);
    await assert.rejects(f.resolve(), changed);
  });
});

integration("Teams manual credential replacement and Human unlink retire the exact native authority and routing", async () => {
  await fixture(async f => {
    const bound = await f.confirm(await f.start());
    await f.repo.unlink(f.input({ spaceId: f.spaces[0], actorUserId: "owner", chatSpace: f.room }));
    assert.equal(await f.repo.current(f.input({ binding: bound })), false);
    const next = await f.confirm(await f.start());
    await f.credentials.put({ requestId: crypto.randomUUID(), spaceId: f.spaces[0], providerId: "teams", actorUserId: "owner",
      fields: { webhookUrl: "https://fixture.webhook.office.com/path" }, policy: { allowed: ["webhookUrl"] }, at: await f.time() });
    assert.equal(await f.repo.current(f.input({ binding: next })), false);
    assert.equal(await f.resolve(), null);
    assert.equal((await f.sql("SELECT count(*) FROM data.app_teams_link_attempts WHERE space_id=$1", [f.spaces[0]])).rows[0].count, "0");
  });
});


integration("Teams primary routing requires the precise native grant, current connection, selected Channel and bounded fanout", async () => {
  await fixture(async f => {
    const selected = await connectorSubscriptionChannel(f.sql, f.spaces[0], 1, "teams");
    await connectorSubscriptionChannel(f.sql, f.spaces[1], 1, "teams");
    let binding = await f.confirm(await f.start());
    const routes = (grant = binding, extra = {}) => f.apps.connectorEventRoutes({ requestId: crypto.randomUUID(),
      connectionId: grant.connectionId, sourceRef: "teams:*", limit: 2, teamsBinding: {
        appIdentity: teamsAppIdentity(f.app), chatSpace: grant.chatSpace, grantGeneration: grant.grantGeneration }, ...extra });
    assert.deepEqual((await routes()).map(row => row.channelId), [selected]);
    assert.deepEqual(await routes({ ...binding, grantGeneration: crypto.randomUUID() }), []);
    assert.deepEqual(await routes(binding, { connectionId: f.spaces[1] + ":teams" }), []);
    await assert.rejects(routes(binding, { googleChatBinding: { appIdentity: "other", chatSpace: "spaces/AbC", grantGeneration: crypto.randomUUID() } }));
    const old = binding; binding = await f.confirm(await f.start()); assert.deepEqual(await routes(old), []);
    for (const index of [2, 3]) await connectorSubscriptionChannel(f.sql, f.spaces[0], index, "teams");
    await assert.rejects(routes(), error => error.status === 503);
    await f.remove(); assert.deepEqual(await routes(), []);
  });
});
