import assert from "node:assert/strict";
import { integration } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";
import { PostgresUserPreferenceRepository, PostgresPushDeviceRepository,
  PostgresAssistantMemoryRepository, PostgresSharedMemoryRepository, PostgresPageRepository } from "../dist/index.js";
import { reconcilePageAutomations, removePageAutomations } from "../dist/automation-page-anchor.js";

// These exercise persistence and complete reads beyond former quotas. Existing
// owner tests cover access, encryption, replay and provider retirement evidence.
integration("a Space saves and reads secrets beyond 128 without weakening ask approval", async () => {
  const f = await spaceSecretFixture();
  try {
    const refs = Array.from({ length: 257 }, (_, n) => `key-${String(n).padStart(3, "0")}`);
    for (const ref of refs.slice(0, 128)) await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin,
      secretRef: ref, value: `value-${ref}`, access: "auto" });
    await f.secret.runCreate(f.run, { secretRef: refs[128], value: "agent-value" });
    for (const ref of refs.slice(129)) await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin,
      secretRef: ref, value: `value-${ref}` });
    const listed = await f.secret.list({ spaceId: f.ids.space, userId: f.ids.owner });
    assert.deepEqual(listed.secrets.map(secret => secret.secretRef), refs);
    assert.ok(listed.secrets.every(secret => !("value" in secret)));
    assert.equal((await f.secret.runList(f.run)).secrets.length, 257);
    assert.equal((await f.secret.runRead(f.run)).secrets.length, 129);
    await assert.rejects(f.secret.runRead(f.run, [refs[256]]), error => error.code === "secret_approval_required");
    await f.secret.approve({ userId: f.ids.admin, runId: f.ids.run, channelId: f.ids.channel, secretRef: refs[256] });
    assert.equal((await f.secret.runRead(f.run, [refs[256]])).secrets[0].value, `value-${refs[256]}`);
    assert.equal((await f.secret.accessStatus({ userId: f.ids.admin, runId: f.ids.run,
      channelId: f.ids.channel, secretRefs: refs })).secrets.length, 257);
  } finally { await f.database.close?.(); await f.close(); }
});

integration("pins beyond 200 round trip completely and still reject an unreadable tail", async () => {
  const f = await spaceSecretFixture();
  try {
    const rows = await f.client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,created_at,updated_at)
      SELECT $1||':pin:'||n,$1,'Pin '||n,'pin-'||n,'open',$1||':pin:'||n,1,'{}',now(),now()
      FROM generate_series(1,1001) n RETURNING channel_id`, [f.ids.space]);
    const pins = rows.rows.map(row => row.channel_id);
    const repository = new PostgresUserPreferenceRepository(f.database);
    const context = { requestId: crypto.randomUUID(), operation: "test.pins",
      placement: { spaceId: f.ids.space, shardId: "shard-0", placementEpoch: 1 } };
    await repository.updateChannelView(context, { commandId: crypto.randomUUID(), spaceId: f.ids.space,
      userId: f.ids.owner, expectedVersion: 0, pinnedChannelIds: pins, at: new Date().toISOString() });
    assert.deepEqual((await repository.readChannelView(context, f.ids.space, f.ids.owner)).pinnedChannelIds, pins);
    await f.client.query("UPDATE data.channels SET mode='closed' WHERE channel_id=$1", [pins.at(-1)]);
    await assert.rejects(repository.updateChannelView(context, { commandId: crypto.randomUUID(), spaceId: f.ids.space,
      userId: f.ids.owner, expectedVersion: 1, pinnedChannelIds: [...pins].reverse(), at: new Date().toISOString() }),
    /Channel the user cannot read/);
    assert.deepEqual((await repository.readChannelView(context, f.ids.space, f.ids.owner)).pinnedChannelIds,
      pins.slice(0, -1));
  } finally {
    await f.client.query("DELETE FROM data.channels WHERE space_id=$1 AND channel_id<>$2", [f.ids.space, f.ids.channel]);
    await f.database.close?.(); await f.close();
  }
});

integration("registering a 21st push device preserves existing devices and reads recipients beyond 500", async () => {
  const f = await spaceSecretFixture();
  const devices = new PostgresPushDeviceRepository(f.database);
  try {
    for (let n = 0; n < 121; n++) await devices.register({ requestId: crypto.randomUUID(), userId: f.ids.owner,
      platform: "fcm", token: `${f.ids.owner}:token:${n}` });
    assert.equal((await devices.listForUsers({ requestId: crypto.randomUUID(), userIds: [f.ids.owner] })).length, 121);
    const users = Array.from({ length: 501 }, (_, n) => `${f.ids.owner}:recipient:${n}`);
    await f.client.query(`INSERT INTO control.push_devices(device_id,user_id,platform,token)
      SELECT md5(u)||md5(u),u,'fcm',u FROM unnest($1::text[]) u`, [users]);
    assert.equal((await devices.listForUsers({ requestId: crypto.randomUUID(), userIds: users })).length, 501);
  } finally {
    await f.client.query("DELETE FROM control.push_devices WHERE user_id=$1 OR user_id=ANY($2::text[])",
      [f.ids.owner, Array.from({ length: 501 }, (_, n) => `${f.ids.owner}:recipient:${n}`)]);
    await f.database.close?.(); await f.close();
  }
});

integration("assistant memory retains entries beyond 80 and shared memory admits more than 10000 small keys", async () => {
  const f = await spaceSecretFixture();
  try {
    const assistant = new PostgresAssistantMemoryRepository(f.database);
    const entries = Array.from({ length: 101 }, (_, n) => ({ id: `entry-${n}`, title: `Entry ${n}`, body: "Keep" }));
    await assistant.update({ commandId: crypto.randomUUID(), ownerUserId: f.ids.owner, update: { upsertEntries: entries } });
    assert.equal((await assistant.get({ requestId: crypto.randomUUID(), ownerUserId: f.ids.owner })).memory.entries.length, 101);
    await f.client.query(`INSERT INTO data.shared_memory_workspace_entries
      (owner_user_id,workspace_id,memory_key,value_json,encoded_bytes,version,created_at,updated_at)
      SELECT $1,$1,'key-'||n,'1',1,1,now(),now() FROM generate_series(1,10000) n`, [f.ids.owner]);
    await new PostgresSharedMemoryRepository(f.database).put({ commandId: crypto.randomUUID(), ownerUserId: f.ids.owner,
      key: "one-more", value: 1 });
    assert.equal((await f.client.query("SELECT count(*)::int AS n FROM data.shared_memory_workspace_entries WHERE owner_user_id=$1",
      [f.ids.owner])).rows[0].n, 10001);
  } finally {
    await f.client.query("DELETE FROM data.assistant_memory_snapshots WHERE owner_user_id=$1", [f.ids.owner]);
    await f.client.query("DELETE FROM data.shared_memory_workspace_entries WHERE owner_user_id=$1", [f.ids.owner]);
    await f.client.query("DELETE FROM control.scoped_control_command_replays WHERE scope_kind='user' AND scope_id=$1", [f.ids.owner]);
    await f.database.close?.(); await f.close();
  }
});

integration("page anchoring reconciles and removes every automation beyond 200", async () => {
  const f = await spaceSecretFixture();
  try {
    await f.client.query(`INSERT INTO data.space_control_heads(space_id,commit_sequence,updated_at)
      VALUES ($1,0,now()) ON CONFLICT DO NOTHING`, [f.ids.space]);
    const { page } = await new PostgresPageRepository(f.database).create({ requestId: crypto.randomUUID(),
      spaceId: f.ids.space, principal: { kind: "user", id: f.ids.owner }, title: "Many Automations", body: "Keep" });
    await f.client.query(`INSERT INTO data.automations
      (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,page_id,created_at,updated_at)
      SELECT $1||':auto:'||lpad(n::text,3,'0'),$2,$3,now()+interval '1 day',true,1,
        '{"name":"Keep","intervalMinutes":60,"message":{"body":"Keep"}}',$4,now(),now()
      FROM generate_series(1,251) n`, [f.ids.space, f.ids.owner, f.ids.channel, page.pageId]);
    const context = { requestId: crypto.randomUUID(), operation: "test.anchors",
      placement: { spaceId: f.ids.space, shardId: "shard-0", placementEpoch: 1 } };
    const input = { spaceId: f.ids.space, pageId: page.pageId, at: new Date().toISOString() };
    const result = await f.database.transaction(context, tx => reconcilePageAutomations(tx, { ...input, body: "", revision: 2 }));
    assert.equal(result.detached.length, 251);
    await f.database.transaction(context, tx => removePageAutomations(tx, input));
    assert.equal((await f.client.query("SELECT count(*)::int AS n FROM data.automations WHERE page_id=$1", [page.pageId])).rows[0].n, 0);
  } finally {
    await f.client.query("DELETE FROM data.automations WHERE channel_id=$1", [f.ids.channel]);
    await f.database.close?.(); await f.close();
  }
});
