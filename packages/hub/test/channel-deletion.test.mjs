import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";
import { createAuthorityDatabase, PostgresSpaceControlRepository, PostgresPageRepository, PostgresAutomationRepository, CHANNEL_PURGE_STEPS } from "@xmatrix/db";
import { requireChannelCapability } from "../../db/src/channel-capability-policy.ts";
import { signAgentRunToken } from "../src/auth.ts";
import { registerChannelDeletionRoutes } from "../src/index-routes-channel-deletion.ts";
import { advanceChannelPurge, maintainChannelDeletions } from "../src/channel-deletion-maintenance.ts";

// This is the owning HTTP/SQL boundary: confirmation, revocation, exact cleanup
// scope and interrupted storage work cannot be proved by a mocked repository.
integration("confirmed Channel deletion revokes access, resumes bounded erasure and preserves other work", async () => {
  const f = await isolatedPostgres("channel_deletion", { shard: true });
  try {
    const env = { AUTH_AUTHORITY: "postgres", RELAY_POSTGRES: { connectionString: f.url.toString() },
      RELAY_POSTGRES_SHARD_ID: "shard-0", HUB_URL: "https://hub.example.test", APP_URL: "https://example.test",
      BETTER_AUTH_SECRET: "isolated-channel-deletion-signing-secret" };
    const keys = await generateKeyPair("ES256");
    await f.run("INSERT INTO control.auth_jwks(id,public_key,private_key,created_at) VALUES('key',$1,'unused',now())",
      [JSON.stringify(await exportJWK(keys.publicKey))]);
    for (const id of ["owner", "member"]) await f.run(`INSERT INTO control.auth_users
      (id,name,email,email_verified,created_at,updated_at) VALUES($1,$1,$1||'@example.test',true,now(),now())`, [id]);
    const token = id => new SignJWT({ email: `${id}@example.test` }).setProtectedHeader({ alg: "ES256", kid: "key" })
      .setIssuer(env.HUB_URL).setAudience(env.HUB_URL).setSubject(id).setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
    const ownerToken = await token("owner"), memberToken = await token("member");
    const agentToken = await signAgentRunToken(env, { id: "owner", email: "owner@example.test", name: "Owner" },
      { agentId: "agent", agentName: "agent", runId: "run", executionKey: "execution", spaceId: "space",
        channelId: "doomed", machineId: "machine", hostId: "host", permissions: [] });
    const database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
    const repo = new PostgresSpaceControlRepository(database, "shard-0");
    for (const spaceId of ["space", "other-space"]) await repo.createSpace({ requestId: randomUUID(), commandId: randomUUID(),
      spaceId, ownerUserId: "owner", name: spaceId });
    await f.run(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES('space','member','member',1,now(),now())`);
    for (const [channelId, spaceId] of [["doomed", "space"], ["kept", "space"], ["foreign", "other-space"]])
      await repo.createChannel({ requestId: randomUUID(), commandId: randomUUID(), channelId, spaceId,
        name: channelId, mode: "open", principal: { kind: "user", id: "owner" } });
    const page = (await new PostgresPageRepository(f.session).create({ requestId: randomUUID(), spaceId: "space",
      principal: { kind: "user", id: "owner" }, title: "Kept Page", body: "Shared work remains" })).page;
    await f.run(`INSERT INTO data.page_links(space_id,link_id,conversation_id,page_id,source,created_by_kind,
      created_by_id,created_at,last_seen_at) VALUES('space','link','doomed',$1,'manual','user','owner',now(),now())`, [page.pageId]);
    const app = new Hono(); registerChannelDeletionRoutes(app);
    const body = { name: "doomed", confirmation: "DELETE", acknowledge: true };
    const send = (value = body, credential = ownerToken, spaceId = "space") => app.fetch(new Request(
      `${env.HUB_URL}/api/spaces/${spaceId}/channels/doomed/deletion`, { method: "POST",
        headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
        body: JSON.stringify(value) }), env);
    assert.equal((await send(body, "")).status, 401);
    assert.equal((await send(body, agentToken)).status, 401, "an Agent cannot confirm destructive Human consent");
    assert.equal((await send(body, memberToken)).status, 403);
    assert.equal((await send({ ...body, acknowledge: false })).status, 400);
    assert.equal((await send({ ...body, name: "old name" })).status, 409);
    assert.equal((await send(body, ownerToken, "other-space")).status, 404, "another Space's admin cannot target the Channel");
    await f.run(`INSERT INTO data.runs(run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES('doomed:1#1','owner','doomed','running',1,'{}',now(),now())`);
    assert.equal((await send()).status, 409, "live work must finish before deletion");
    assert.equal((await f.run("SELECT count(*)::int AS n FROM data.channel_deletions"))[0].n, 0);
    await f.run("UPDATE data.runs SET status='completed',finished_at=now() WHERE run_id='doomed:1#1'");
    await f.run(`INSERT INTO data.messages(space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,
      author_id,message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,legacy_body,created_at)
      SELECT s,c,c||'-message-'||n,n,1,'user','owner','message','hash','inline','inline',now(),now(),
        c||'-rank-'||n,'body for '||c,now() FROM (VALUES ('space','doomed',2501),
        ('space','kept',1),('other-space','foreign',1)) targets(s,c,amount), generate_series(1,amount) n`);
    await f.run(`INSERT INTO data.automations(automation_id,owner_user_id,channel_id,next_run_at,enabled,version,
      payload_json,created_at,updated_at,page_id) VALUES('schedule','owner','doomed',now(),true,1,
        '{"payloadVersion":2,"message":{"body":"private scheduled input"}}',now(),now(),$1)`, [page.pageId]);
    await f.run(`INSERT INTO data.user_space_channel_view_preferences(space_id,user_id,follow_up_review_schedule,
      pinned_channel_ids_json,version,created_at,updated_at) VALUES('space','owner','off','["doomed","kept"]',1,now(),now())`);
    const scope = `channel-user:doomed:owner`, foreignScope = "channel-user:foreign:owner";
    const privateKey = `restricted/${encodeURIComponent(scope)}/objects/${"a".repeat(64)}`;
    const foreignKey = `restricted/${encodeURIComponent(foreignScope)}/objects/${"b".repeat(64)}`;
    const sharedKey = `objects/${"c".repeat(64)}`;
    const insertAttachment = (id, key, channelId = "doomed", spaceId = "space") => f.run(`INSERT INTO data.message_attachments
      (space_id,attachment_id,message_id,channel_id,object_key,content_hash,encoded_bytes,mime_type,name,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'hash',1,'text/plain','a',1,now(),now())`,
      [spaceId, id, channelId === "doomed" ? "doomed-message-1" : null, channelId, key]);
    for (const [id, key] of [["private", privateKey], ["foreign-pointer", foreignKey], ["shared", sharedKey]])
      await insertAttachment(id, key);
    const requested = await send();
    assert.equal(requested.status, 202, await requested.clone().text());
    assert.deepEqual(await requested.json(), { state: "purging", channelId: "doomed", spaceId: "space" });
    assert.equal((await send()).status, 202, "the same target is a recoverable request");
    const closure = await repo.mutateSpace({ requestId: randomUUID(), commandId: randomUUID(), kind: "space_delete",
      spaceId: "space", actorUserId: "owner", at: new Date().toISOString() });
    const due = new Date(Date.parse(closure.deletion.purgeAfter) + 1000).toISOString();
    const waiting = await repo.purgeSpaceStep({ requestId: randomUUID(), spaceId: "space", now: due });
    assert.equal(waiting.status, "waiting", "Space purge must preserve the placement of pending Channel cleanup");
    await repo.restoreSpace({ requestId: randomUUID(), commandId: randomUUID(), spaceId: "space",
      actorUserId: "owner", at: new Date().toISOString() });
    const schedules = new PostgresAutomationRepository(f.session);
    await schedules.maintain({ requestId: randomUUID(), now: new Date().toISOString(), runTimeoutMs: 1000 });
    assert.equal((await f.run("SELECT count(*)::int AS n FROM data.automation_occurrences"))[0].n, 0,
      "a retired Channel cannot create another occurrence even before its schedule is purged");
    for (const capability of ["message_content_read", "message_append", "runtime_new_work", "content_new_work"])
      await assert.rejects(f.session.transaction({ requestId: randomUUID(), operation: "test.retired-channel" },
        tx => requireChannelCapability(tx, { capability, channelId: "doomed", spaceId: "space",
          principal: { kind: "user", id: "owner" }, error: failure => Object.assign(new Error(failure.message), failure) })),
        error => error.code === "channel_not_found");
    const catalog = await repo.listChannels({ requestId: randomUUID(), spaceId: "space", principal: { kind: "user", id: "owner" } });
    assert.deepEqual(catalog.channels.map(c => c.id), ["kept"]);
    await assert.rejects(repo.mutateChannel({ requestId: randomUUID(), commandId: randomUUID(), kind: "channel_configure",
      channelId: "doomed", actorUserId: "owner", at: new Date().toISOString(), mode: "open" }), error => error.status === 404);
    let fail = true;
    const deleted = [];
    const bucket = { delete: async keys => { if (fail) throw new Error("Storage interrupted"); deleted.push(...keys); } };
    const target = { spaceId: "space", channelId: "doomed", shardId: "shard-0", placementEpoch: 1 };
    await assert.rejects(advanceChannelPurge(f.session, bucket, target), /Storage interrupted/);
    assert.equal((await f.run("SELECT object_cursor FROM data.channel_deletions WHERE channel_id='doomed'"))[0].object_cursor, "");
    assert.equal((await f.run("SELECT count(*)::int AS n FROM data.messages"))[0].n, 2503);
    for (const channelId of ["parallel", "ready"]) await repo.createChannel({ requestId: randomUUID(), commandId: randomUUID(),
      channelId, spaceId: "other-space", name: channelId, mode: "open", principal: { kind: "user", id: "owner" } });
    const parallelKey = `restricted/${encodeURIComponent("channel-user:parallel:owner")}/objects/${"d".repeat(64)}`;
    await insertAttachment("parallel-private", parallelKey, "parallel", "other-space");
    for (const channelId of ["parallel", "ready"]) await repo.deleteChannel({ requestId: randomUUID(), spaceId: "other-space",
      channelId, actorUserId: "owner", name: channelId, at: new Date().toISOString() });
    const maintain = () => maintainChannelDeletions({ ...env, RELAY_PAYLOAD_BUCKET: bucket });
    await assert.rejects(maintain(), /requires retry/);
    assert.equal((await f.run("SELECT state FROM data.channel_deletions WHERE channel_id='ready'"))[0].state, "purging");
    await assert.rejects(maintain(), /requires retry/);
    assert.ok((await f.run("SELECT step FROM data.channel_deletions WHERE channel_id='ready'"))[0].step > 0,
      "two failing storage jobs must yield the next pass to another Channel's erasure");
    fail = false;
    await maintain();
    assert.ok((await f.run("SELECT step FROM data.channel_deletions WHERE channel_id='parallel'"))[0].step > 0);
    let previous = (await f.run("SELECT purged_rows FROM data.channel_deletions WHERE channel_id='doomed'"))[0].purged_rows;
    assert.ok(Number(previous) <= 2000);
    for (let attempt = 0; attempt < 32; attempt++) {
      await maintain();
      const [job] = await f.run("SELECT state,purged_rows FROM data.channel_deletions WHERE channel_id='doomed'");
      assert.ok(Number(job.purged_rows) - Number(previous) <= 2000);
      previous = job.purged_rows;
      if (!(await f.run("SELECT 1 FROM data.channel_deletions WHERE state='purging'")).length) break;
    }
    assert.deepEqual([...deleted].sort(), [privateKey, parallelKey].sort(), "only each confirmed Channel's private bytes are deleted");
    assert.equal((await f.run("SELECT state FROM data.channel_deletions WHERE channel_id='doomed'"))[0].state, "completed");
    assert.deepEqual(await f.run("SELECT channel_id,legacy_body FROM data.messages ORDER BY channel_id"), [
      { channel_id: "foreign", legacy_body: "body for foreign" }, { channel_id: "kept", legacy_body: "body for kept" },
    ]);
    assert.ok((await f.run("SELECT body FROM data.page_revisions"))[0].body.includes("Shared work remains"));
    assert.equal((await f.run("SELECT count(*)::int AS n FROM data.channels"))[0].n, 2);
    assert.equal((await f.run("SELECT count(*)::int AS n FROM data.pages"))[0].n, 1);
    assert.equal((await f.run("SELECT count(*)::int AS n FROM data.page_links"))[0].n, 0);
    assert.deepEqual((await f.run("SELECT pinned_channel_ids_json FROM data.user_space_channel_view_preferences"))[0].pinned_channel_ids_json, ["kept"]);
    assert.equal((await send()).status, 202, "receipt recovery outlives physical row cleanup");
    assert.equal((await (await send()).json()).state, "completed");
    await assert.rejects(repo.createChannel({ requestId: randomUUID(), commandId: randomUUID(), channelId: "doomed",
      spaceId: "space", name: "recreated", mode: "open", principal: { kind: "user", id: "owner" } }), /retired/);
    // Every current Channel-keyed table is either erased or an explicit locator/audit/view.
    const keyed = await f.run(`SELECT DISTINCT c.table_schema||'.'||c.table_name AS name FROM information_schema.columns c
      JOIN information_schema.tables t USING(table_schema,table_name) WHERE c.table_schema IN ('data','control')
      AND c.column_name IN ('channel_id','conversation_id','source_channel_id') AND t.table_type='BASE TABLE'`);
    const classified = new Set(CHANNEL_PURGE_STEPS.map(step => step.table));
    for (const name of ["data.channels", "data.channel_deletions", "control.channel_space_routes", "control.channel_space_directory"]) classified.add(name);
    assert.deepEqual(keyed.map(row => row.name).filter(name => !classified.has(name)), []);
  } finally { await f.close(); }
});
