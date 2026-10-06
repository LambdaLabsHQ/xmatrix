import assert from "node:assert/strict";
import { connectorDatabase, integration } from "./postgres-database.fixture.mjs";
import { PostgresTelegramRoomRepository, PostgresAppRepository, PostgresAppCredentialRepository, telegramAppIdentity } from "../dist/index.js";
async function telegramTest(run) {
  const { client, database, sql } = await connectorDatabase("telegram-native-test");
  const spaces = [crypto.randomUUID(), crypto.randomUUID()], chatSpace = "-100123456789";
  const app = { providerId: "telegram", botId: String(100000+Math.floor(Math.random()*899999)), eventKeyDigest: "b".repeat(64) };
  const rooms = new PostgresTelegramRoomRepository(database), apps = new PostgresAppRepository(database);
  const request = values => ({ requestId: crypto.randomUUID(), app, ...values });
  const now = async () => (await sql("SELECT date_trunc('second',clock_timestamp()) AS at")).rows[0].at.toISOString();
  const begin = (index = 0, room = chatSpace) => rooms.begin(request({ spaceId: spaces[index], chatSpace: room, actorUserId: "owner" }));
  const confirm = async (attempt, extra = {}) => rooms.confirm(request({ chatSpace: attempt.chatSpace, nonce: attempt.nonce, eventTime: await now(), ...extra }));
  try {
    for (const spaceId of spaces) {
      await sql("INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at) VALUES ($1,'owner','owner',1,now(),now())", [spaceId]);
      await sql(`INSERT INTO data.app_connector_connections
        (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
        SELECT $1,$1||':telegram',1,'telegram','Telegram','disconnected','api-token','[]','[]','[]','[]','owner',$1||':generation',now(),now()`, [spaceId]);
    }
    await run({ rooms, apps, request, now, begin, confirm, sql, spaces, app, chatSpace, database });
  } finally {
    await sql("DELETE FROM data.app_telegram_room_lifecycle WHERE app_identity=$1", [telegramAppIdentity(app)]);
    for (const table of ["app_source_relations", "channels", "app_connector_connections", "space_members"]) await sql(`DELETE FROM data.${table} WHERE space_id=ANY($1::text[])`, [spaces]);
    try { await database.close?.(); } finally { await client.end(); }
  }
}
integration("Telegram seconds-precision challenge stays private and requires current Space admin; replay and rotation fail", async () => telegramTest(async f => {
  const attempt = await f.begin();
  const row = (await f.sql("SELECT * FROM data.app_telegram_link_attempts WHERE space_id=$1", [f.spaces[0]])).rows[0];
  assert.equal(row.started_at.getMilliseconds(), 0); assert.equal(row.expires_at-row.started_at, 180000); assert.ok(!JSON.stringify(row).includes(attempt.nonce));
  const bound = await f.confirm(attempt); assert.ok(await f.rooms.current(f.request({ binding: bound })));
  await assert.rejects(f.confirm(attempt), { status: 409 });
  const next = await f.begin(); await assert.rejects(f.confirm(next, { app: { ...f.app, eventKeyDigest: "c".repeat(64) } }), { status: 409 });
  await f.sql("UPDATE data.space_members SET role='member' WHERE space_id=$1", [f.spaces[0]]);
  await assert.rejects(f.confirm(next), { status: 404 });
}));
integration("Telegram expired, superseded and wrong-group nonces cannot connect", async () => telegramTest(async f => {
  const old = await f.begin(), current = await f.begin(); await assert.rejects(f.confirm(old), { status: 409 });
  await assert.rejects(f.confirm(current, { chatSpace: "-999" }), { status: 409 });
  await f.sql("UPDATE data.app_telegram_link_attempts SET started_at=now()-interval '4 minutes', expires_at=now()-interval '1 minute' WHERE space_id=$1", [f.spaces[0]]);
  await assert.rejects(f.confirm(current), { status: 409 });
  for (const room of ["100", "-01", "-9999999999999999", "-0", "@group"]) await assert.rejects(f.begin(0, room), { status: 400 });
}));
integration("Concurrent Telegram confirmation grants the group to exactly one Space", async () => telegramTest(async f => {
  const pending = await Promise.all([f.begin(0), f.begin(1)]);
  const results = await Promise.allSettled(pending.map(attempt => f.confirm(attempt)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
}));
integration("Telegram grants twenty groups, unlinks one and rejects cross-Space unlink", async () => telegramTest(async f => {
  for (let index=1;index<=20;index++) await f.confirm(await f.begin(0, `-${index}`));
  await assert.rejects(f.confirm(await f.begin(0, "-21")), error => error.code === "chat_room_limit");
  await f.rooms.unlink(f.request({ spaceId: f.spaces[1], actorUserId: "owner", chatSpace: "-1" }));
  assert.equal((await f.rooms.list(f.request({ spaceId: f.spaces[0] }))).length, 20);
  await f.rooms.unlink(f.request({ spaceId: f.spaces[0], actorUserId: "owner", chatSpace: "-1" }));
  assert.equal((await f.rooms.list(f.request({ spaceId: f.spaces[0] }))).length, 19);
  await f.confirm(await f.begin(1, "-1"));
}));
integration("Telegram removal fences old delivery and requires new confirmation; unrelated groups stay active", async () => telegramTest(async f => {
  const first = await f.confirm(await f.begin()), second = await f.confirm(await f.begin(0, "-222"));
  const removedAt = await f.now(); await f.rooms.remove(f.request({ chatSpace: f.chatSpace, eventTime: removedAt }));
  assert.equal(await f.rooms.current(f.request({ binding: first })), false); assert.equal(await f.rooms.current(f.request({ binding: second })), true);
  assert.equal(await f.rooms.route(f.request({ chatSpace: f.chatSpace, eventTime: await f.now() })), null);
  // Telegram rounds to seconds; advance the isolated database clock before fresh proof.
  await f.sql("SELECT pg_sleep(1.05)");
  const renewed = await f.confirm(await f.begin()); await f.rooms.remove(f.request({ chatSpace: f.chatSpace, eventTime: removedAt }));
  assert.equal(await f.rooms.current(f.request({ binding: renewed })), true);
  assert.equal(await f.rooms.current(f.request({ binding: first })), false);
  assert.equal(await f.rooms.route(f.request({ chatSpace: f.chatSpace, eventTime: removedAt })), null);
}));
integration("Manual Telegram credentials clear all pending/native grants and connection ABA blocks confirmation", async () => telegramTest(async f => {
  const bound = await f.confirm(await f.begin()), pending = await f.begin();
  const credentials = new PostgresAppCredentialRepository(f.database, "telegram-fixture-encryption");
  await credentials.put({ requestId: crypto.randomUUID(), spaceId: f.spaces[0], providerId: "telegram", actorUserId: "owner", fields: { botToken: "fixture" }, policy: { allowed: ["botToken"] }, at: new Date().toISOString() });
  assert.equal(await f.rooms.current(f.request({ binding: bound })), false); await assert.rejects(f.confirm(pending), { status: 409 });
  const next = await f.begin(); await f.sql("UPDATE data.app_connector_connections SET search_rank_sequence='other-generation' WHERE space_id=$1", [f.spaces[0]]);
  await assert.rejects(f.confirm(next), { status: 409 });
}));
integration("Telegram primary routes match exact active app/group/grant and reject removal before delivery", async () => telegramTest(async f => {
  const bound = await f.confirm(await f.begin()), channelId = crypto.randomUUID(), sourceRef = `telegram:${f.chatSpace}`;
  await f.sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
    SELECT $1,$2,'fixture',$1,'open',$1||':rank',1,now(),now()`, [channelId, f.spaces[0]]);
  await f.sql(`INSERT INTO data.app_source_relations (relation_id,space_id,connection_id,channel_id,source_kind,source_ref,features_json,version,created_by,created_at,updated_at)
    SELECT $1,$2,$2||':telegram',$3,'repository',$4,'["messages"]',1,'owner',now(),now()`, [crypto.randomUUID(), f.spaces[0], channelId, sourceRef]);
  const read = extra => f.apps.connectorEventRoutes({ requestId: crypto.randomUUID(), connectionId: bound.connectionId, sourceRef, limit: 32,
    telegramBinding: { appIdentity: telegramAppIdentity(f.app), chatSpace: f.chatSpace, grantGeneration: bound.grantGeneration, ...extra } });
  assert.equal((await read()).length, 1); assert.equal((await read({ chatSpace: "-999" })).length, 0); assert.equal((await read({ grantGeneration: crypto.randomUUID() })).length, 0);
  await f.rooms.remove(f.request({ chatSpace: f.chatSpace, eventTime: await f.now() })); assert.equal((await read()).length, 0);
}));
