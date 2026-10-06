import assert from "node:assert/strict";
import { connectorDatabase, integration } from "./postgres-database.fixture.mjs";
import { PostgresFeishuRoomRepository, PostgresFeishuAppRepository, PostgresAppCredentialRepository,
  PostgresAppRepository, feishuAppIdentity } from "../dist/index.js";

async function fixture(run) {
  const { client, database, sql } = await connectorDatabase("feishu-company-test");
  const prefix = "feishu-test-" + crypto.randomUUID(), spaces = [prefix + "-a", prefix + "-b"];
  const app = { providerId: "feishu", appId: "cli_" + crypto.randomUUID().replaceAll("-", ""), apiOrigin: "https://open.feishu.cn", eventKeyDigest: "a".repeat(64) };
  const identity = feishuAppIdentity(app), chatSpace = "tenantA/oc_AbCd";
  const rooms = new PostgresFeishuRoomRepository(database), authority = new PostgresFeishuAppRepository(database, "fixture-encryption-material");
  const credentials = new PostgresAppCredentialRepository(database, "fixture-encryption-material"), apps = new PostgresAppRepository(database);
  const request = extra => ({ requestId: crypto.randomUUID(), app, ...extra });
  const time = async () => (await sql("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
  const event = async extra => request({ eventId: crypto.randomUUID(), eventTime: await time(), ...extra });
  const lifecycle = async (active, extra = {}) => authority.applyTenant(await event({ tenantKey: "tenantA", active, ...extra }));
  const begin = (index = 0, extra = {}) => rooms.begin(request({ spaceId: spaces[index], actorUserId: "owner", chatSpace, ...extra }));
  const confirm = async (attempt, extra = {}) => rooms.confirm(request({ chatSpace: attempt.chatSpace, nonce: attempt.nonce, eventTime: await time(), ...extra }));
  const resolve = (index = 0, extra = {}) => rooms.resolve(request({ spaceId: spaces[index], chatSpace, ...extra }));
  try {
    for (const space of spaces) {
      await sql(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
        VALUES ($1,'owner','owner',1,now(),now()),($1,'member','member',1,now(),now())`, [space]);
      await sql(`INSERT INTO data.app_connector_connections
        (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
         capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
        VALUES ($1,$1||':feishu',1,'feishu','Feishu','disconnected','api-token','[]','[]','[]','[]','owner',$1||':generation',now(),now())`, [space]);
    }
    await lifecycle(true);
    await run({ sql, database, spaces, app, identity, rooms, authority, credentials, apps, request, event, lifecycle, begin, confirm, resolve, time, chatSpace });
  } finally {
    for (const table of ["app_feishu_tickets", "app_feishu_tenant_lifecycle", "app_feishu_room_lifecycle"]) await sql(`DELETE FROM data.${table} WHERE app_identity=$1`, [identity]);
    for (const table of ["app_source_relations", "channels", "app_connector_connections", "space_deletions", "space_members"]) {
      for (const space of spaces) await sql(`DELETE FROM data.${table} WHERE space_id=$1`, [space]);
    }
    await database.close?.(); await client.end();
  }
}
const invalid = error => error.status === 409;
integration("Feishu ticket is encrypted/version-bound, monotonically updated and never accepts replay or transplanted ciphertext", async () => {
  await fixture(async ({ authority, event, sql, identity, request }) => {
    const first = await event({ ticket: "private-fixture-ticket" }); await authority.acceptTicket(first);
    const row = (await sql("SELECT * FROM data.app_feishu_tickets WHERE app_identity=$1", [identity])).rows[0];
    assert.doesNotMatch(JSON.stringify(row), /private-fixture-ticket/); assert.equal(await authority.ticket(request()), "private-fixture-ticket");
    await authority.acceptTicket({ ...first, eventId: "older", eventTime: new Date(Date.parse(first.eventTime) - 1000).toISOString(), ticket: "older-ticket" });
    await authority.acceptTicket({ ...first, eventTime: new Date(Date.parse(first.eventTime) + 1).toISOString(), ticket: "same-id-ticket" });
    assert.equal(await authority.ticket(request()), "private-fixture-ticket");
    await authority.acceptTicket(await event({ ticket: "new-fixture-ticket" })); assert.equal(await authority.ticket(request()), "new-fixture-ticket");
    await sql("UPDATE data.app_feishu_tickets SET encrypted_value_json=$2::jsonb WHERE app_identity=$1", [identity, JSON.stringify(row.encrypted_value_json)]);
    await assert.rejects(authority.ticket(request()), error => error.code === "secret_authority_corrupt");
  });
});
integration("missing, stale and malformed app lifecycle evidence fails closed", async () => {
  await fixture(async ({ authority, event, request, lifecycle, begin, sql, identity }) => {
    await assert.rejects(authority.ticket(request()), error => error.code === "feishu_ticket_missing");
    await assert.rejects(authority.acceptTicket(await event({ ticket: "stale-ticket", eventTime: new Date(Date.now()-700000).toISOString() })), invalid);
    await assert.rejects(lifecycle(true, { eventTime: "2026-02-30T10:00:00Z" }), error => error.status === 400);
    await sql("DELETE FROM data.app_feishu_tenant_lifecycle WHERE app_identity=$1", [identity]);
    await assert.rejects(begin(), invalid);
  });
});
integration("tenant stop wins same-time enable and later enable does not resurrect retired room grants", async () => {
  await fixture(async ({ authority, event, lifecycle, begin, confirm, resolve, rooms, request, chatSpace }) => {
    const bound = await confirm(await begin());
    const stopped = await event({ tenantKey: "tenantA", active: false }); await authority.applyTenant(stopped);
    await authority.applyTenant({ ...stopped, eventId: "same-time-start", active: true });
    await assert.rejects(resolve(), invalid); assert.equal(await rooms.current(request({ binding: bound })), false);
    await lifecycle(true); await assert.rejects(resolve(), invalid);
    const renewed = await confirm(await begin()); assert.notEqual(renewed.grantGeneration, bound.grantGeneration);
    assert.equal(await rooms.current(request({ binding: bound })), false);
    assert.ok(await rooms.route(request({ chatSpace, eventTime: (await event({})).eventTime })));
  });
});
integration("native Human challenge is private, exact-tenant/group, admin-bound and expires without activation", async () => {
  await fixture(async ({ begin, confirm, resolve, sql, spaces }) => {
    await assert.rejects(begin(0, { actorUserId: "member" }), error => error.status === 404);
    const attempt = await begin();
    assert.equal(await resolve(), null);
    const row = (await sql("SELECT * FROM data.app_feishu_link_attempts WHERE space_id=$1", [spaces[0]])).rows[0];
    assert.doesNotMatch(JSON.stringify(row), new RegExp(attempt.nonce)); assert.equal(row.expires_at - row.started_at, 180000);
    await assert.rejects(confirm(attempt, { chatSpace: "tenantB/oc_AbCd" }), invalid);
    await sql("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id='owner'", [spaces[0]]);
    await assert.rejects(confirm(attempt), error => error.status === 404);
  });
});
integration("replaced, expired and consumed confirmations cannot activate native credentials", async () => {
  await fixture(async ({ begin, confirm, sql, spaces }) => {
    const old = await begin(), latest = await begin(); await assert.rejects(confirm(old), invalid);
    await sql("UPDATE data.app_feishu_link_attempts SET started_at=now()-interval '4 minutes',expires_at=now()-interval '1 minute' WHERE space_id=$1", [spaces[0]]);
    await assert.rejects(confirm(latest), invalid);
    const current = await begin(); await confirm(current); await assert.rejects(confirm(current), invalid);
  });
});
integration("twenty independently confirmed rooms are allowed; a twenty-first is denied without discarding current rooms", async () => {
  await fixture(async ({ begin, confirm, rooms, request, spaces }) => {
    for (let i=0;i<20;i++) await confirm(await begin(0, { chatSpace: `tenantA/oc_Chat${i}` }));
    assert.equal((await rooms.list(request({ spaceId: spaces[0] }))).length, 20);
    await assert.rejects(confirm(await begin(0, { chatSpace: "tenantA/oc_Chat20" })), error => error.code === "chat_room_limit");
    assert.equal((await rooms.list(request({ spaceId: spaces[0] }))).length, 20);
    await confirm(await begin(0, { chatSpace: "tenantA/oc_Chat0" }));
  });
});
integration("one active room belongs to one Space under concurrent confirmation", async () => {
  await fixture(async ({ begin, confirm, sql, identity }) => {
    const attempts = await Promise.all([begin(0), begin(1)]);
    const results = await Promise.allSettled(attempts.map(attempt => confirm(attempt)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await sql("SELECT count(*) FROM data.app_feishu_room_bindings WHERE app_identity=$1 AND active", [identity])).rows[0].count, "1");
  });
});
integration("removal retires only its group; delayed old removal cannot revoke newer proof", async () => {
  await fixture(async ({ begin, confirm, rooms, request, time, spaces, chatSpace }) => {
    const first = await confirm(await begin()), second = await confirm(await begin(0, { chatSpace: "tenantA/oc_Other" }));
    const removedAt = await time(); await rooms.remove(request({ chatSpace, eventTime: removedAt }));
    assert.equal(await rooms.current(request({ binding: first })), false); assert.equal(await rooms.current(request({ binding: second })), true);
    const renewed = await confirm(await begin()); await rooms.remove(request({ chatSpace, eventTime: removedAt }));
    assert.equal(await rooms.current(request({ binding: renewed })), true); assert.equal((await rooms.list(request({ spaceId: spaces[0] }))).length, 2);
  });
});
integration("manual credential replacement and connection ABA fence pending and captured grants", async () => {
  await fixture(async ({ begin, confirm, credentials, rooms, request, spaces, sql, resolve }) => {
    const bound = await confirm(await begin()), pending = await begin();
    await credentials.put({ requestId: crypto.randomUUID(), spaceId: spaces[0], providerId: "feishu", actorUserId: "owner",
      fields: { appId: "fixture-manual-app", appSecret: "fixture-manual-value" }, policy: { allowed: ["appId", "appSecret"] }, at: new Date().toISOString() });
    assert.equal(await rooms.current(request({ binding: bound })), false); await assert.rejects(confirm(pending), invalid);
    const fresh = await begin(); await sql("UPDATE data.app_connector_connections SET search_rank_sequence='replacement-generation' WHERE space_id=$1", [spaces[0]]);
    await assert.rejects(confirm(fresh), invalid); assert.equal(await resolve(), null);
  });
});
integration("Human unlink affects only the selected group, clears pending proof and requires current admin", async () => {
  await fixture(async ({ begin, confirm, rooms, request, spaces, chatSpace }) => {
    const first = await confirm(await begin()), second = await confirm(await begin(0, { chatSpace: "tenantA/oc_Other" }));
    const pending = await begin();
    await assert.rejects(rooms.unlink(request({ spaceId: spaces[0], actorUserId: "member", chatSpace })), error => error.status === 404);
    await rooms.unlink(request({ spaceId: spaces[0], actorUserId: "owner", chatSpace }));
    assert.equal(await rooms.current(request({ binding: first })), false); assert.equal(await rooms.current(request({ binding: second })), true);
    await assert.rejects(confirm(pending), invalid); const move = await begin(1); await confirm(move);
  });
});
integration("primary subscription routes require current exact room grant and tenant availability", async () => {
  await fixture(async ({ begin, confirm, apps, lifecycle, sql, identity, spaces, chatSpace }) => {
    const bound = await confirm(await begin()); const channelId = "channel-"+crypto.randomUUID(), sourceRef = "feishu:room-fixture";
    await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at) VALUES ($1,$2,'channel',$1,'open',$1||':rank',1,now(),now())`, [channelId, spaces[0]]);
    await sql(`INSERT INTO data.app_source_relations (relation_id,space_id,connection_id,channel_id,source_kind,source_ref,features_json,version,created_by,created_at,updated_at)
      VALUES ($1,$2,$2||':feishu',$3,'repository',$4,'["messages"]',1,'owner',now(),now())`, ["relation-"+crypto.randomUUID(), spaces[0], channelId, sourceRef]);
    const read = extra => apps.connectorEventRoutes({ requestId: crypto.randomUUID(), connectionId: bound.connectionId, sourceRef, limit: 32,
      feishuBinding: { appIdentity: identity, chatSpace, grantGeneration: bound.grantGeneration, ...extra } });
    assert.equal((await read()).length, 1); assert.equal((await read({ chatSpace: "tenantB/oc_AbCd" })).length, 0);
    assert.equal((await read({ grantGeneration: crypto.randomUUID() })).length, 0);
    await lifecycle(false); assert.equal((await read()).length, 0); await lifecycle(true); assert.equal((await read()).length, 0);
  });
});

integration("out-of-order stop preserves later enabled status while retiring every pre-stop group proof", async () => {
  await fixture(async ({ authority, event, lifecycle, begin, confirm, resolve, rooms, request }) => {
    const old = await confirm(await begin()), stop = await event({ tenantKey: "tenantA", active: false });
    await lifecycle(true, { eventTime: new Date(Date.parse(stop.eventTime) + 1).toISOString() }); await authority.applyTenant(stop);
    await authority.assertTenant(request({ tenantKey: "tenantA" }));
    await assert.rejects(resolve(), invalid); assert.equal(await rooms.current(request({ binding: old })), false);
    const renewed = await confirm(await begin()); await authority.applyTenant(stop);
    assert.equal(await rooms.current(request({ binding: renewed })), true);
  });
});

integration("bounded maintenance expires old challenges and removal fences without reviving retired groups", async () => {
  await fixture(async ({ begin, confirm, rooms, request, sql, identity, chatSpace, time }) => {
    const retired = await confirm(await begin()), live = await confirm(await begin(0, { chatSpace: "tenantA/oc_Live" }));
    await rooms.remove(request({ chatSpace, eventTime: await time() }));
    await begin(1, { chatSpace: "tenantA/oc_Pending" });
    await sql("UPDATE data.app_feishu_link_attempts SET started_at=now()-interval '4 minutes',expires_at=now()-interval '1 minute' WHERE app_identity=$1", [identity]);
    await sql("UPDATE data.app_feishu_room_lifecycle SET removed_at=now()-interval '2 days' WHERE app_identity=$1", [identity]);
    await sql("INSERT INTO data.app_feishu_room_lifecycle (app_identity,chat_space,removed_at) VALUES ($1,'tenantA/oc_Other',now()-interval '2 days')", [identity]);
    await assert.rejects(rooms.cleanup({ requestId: crypto.randomUUID(), limit: 257 }), error => error.status === 400);
    await rooms.cleanup({ requestId: crypto.randomUUID(), limit: 1 });
    assert.equal((await sql("SELECT count(*) FROM data.app_feishu_link_attempts WHERE app_identity=$1", [identity])).rows[0].count, "0");
    assert.equal((await sql("SELECT count(*) FROM data.app_feishu_room_lifecycle WHERE app_identity=$1", [identity])).rows[0].count, "1");
    assert.equal(await rooms.current(request({ binding: retired })), false);
    assert.equal(await rooms.current(request({ binding: live })), true);
  });
});
