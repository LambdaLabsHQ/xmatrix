import { postgresDatabase as database, connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";

import { Client } from "pg";

import { PostgresCrossSpaceReadRepository } from "../dist/cross-space-read-control.js";
import { PostgresSupportHandoffRepository } from "../dist/support-handoff-control.js";
import { supportAccessNoteBody } from "../dist/support-handoff-grants.js";
import { registeredRunRows } from "./registered-run.fixture.mjs";



async function fixture(client, id) {
  const ids = {
    home: `${id}-home`, target: `${id}-target`, owner: `${id}-owner`, teammate: `${id}-teammate`,
    source: `${id}-source`, debug: `${id}-debug`, thread: `${id}-thread`, secret: `${id}-secret`,
    sibling: `${id}-sibling`, agent: `${id}-agent`, customer: `${id}-customer`, mine: `${id}-mine`,
    viewer: `${id}-viewer`, admin: `${id}-admin`,
  };
  // Instance and Run ids are natural keys of the Channel they run in.
  ids.instance = `${ids.source}:1`;
  ids.run = `${ids.instance}#1`;
  ids.supportRuns = [];
  await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
    VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
  for (const spaceId of [ids.home, ids.target]) {
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [spaceId]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,'Cross-Space read test',$1,1,'{}',now(),now())`, [spaceId, ids.owner]);
  }
  for (const [spaceId, userId, role] of [[ids.home, ids.owner, "owner"], [ids.home, ids.teammate, "member"],
    // In the target Space the Run's owner is a member, so a closed Channel stays closed to them.
    [ids.target, ids.owner, "member"], [ids.target, ids.admin, "admin"], [ids.target, ids.customer, "member"],
    [ids.home, ids.viewer, "viewer"]]) {
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$2,$3,1,now(),now())`, [spaceId, userId, role]);
  }
  for (const [channelId, spaceId, mode, , metadata] of [
    [ids.source, ids.home, "open", null, {}],
    [ids.debug, ids.target, "open", null, {}],
    [ids.thread, ids.target, "open", ids.debug,
      { kind: "thread", threadRootChannelId: ids.debug, threadRootMessageId: "root" }],
    [ids.sibling, ids.target, "open", null, {}],
    // The customer's own conversation.
    [ids.mine, ids.target, "open", null, { xmatrixCreatedByUserId: ids.customer }],
    // A closed Channel granted to nobody.
    [ids.secret, ids.target, "closed", null, {}],
  ]) {
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
       metadata_json,created_at,updated_at)
      VALUES ($1,$2,$1,$1,$3,$1,1,$4::jsonb,now(),now())`,
    [channelId, spaceId, mode, JSON.stringify(metadata)]);
    await client.query(`INSERT INTO control.channel_space_routes
      (channel_id,space_id,shard_id,placement_epoch,entity_version,state,updated_at)
      VALUES ($1,$2,'shard-0',1,1,'active',now())`, [channelId, spaceId]);
  }
  await client.query(`INSERT INTO data.runs
    (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,$3,'running',1,'{"executionKey":"execution-1"}',now(),now())`,
  [ids.run, ids.owner, ids.source]);
  await client.query(`INSERT INTO data.instances
    (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
    VALUES ($1,$2,$3,1,'online',1,now(),now())`, [ids.instance, ids.run, ids.source]);
  await client.query(`INSERT INTO control.entity_space_routes
    (entity_kind,entity_id,space_id,shard_id,placement_epoch,entity_version,route_version,state,updated_at)
    VALUES ('run',$1,$2,'shard-0',1,1,1,'active',now())`, [ids.run, ids.home]);
  return ids;
}

async function cleanup(client, ids) {
  for (const runId of ids.supportRuns ?? []) {
    await client.query("DELETE FROM control.entity_space_routes WHERE entity_id=$1", [runId]).catch(() => {});
    await client.query("DELETE FROM data.instances WHERE run_id=$1", [runId]).catch(() => {});
    await client.query("DELETE FROM data.runs WHERE run_id=$1", [runId]).catch(() => {});
  }
  await client.query("DELETE FROM data.cross_space_read_grants WHERE space_id=$1", [ids.target]).catch(() => {});
  await client.query("DELETE FROM data.runs WHERE channel_id=$1", [ids.mine]).catch(() => {});
  await client.query("DELETE FROM data.cross_space_read_grants WHERE run_id=$1", [ids.run]).catch(() => {});
  await client.query("DELETE FROM data.cross_space_read_notices WHERE space_id=$1", [ids.home]).catch(() => {});
  await client.query("DELETE FROM control.entity_space_routes WHERE entity_id=$1", [ids.run]).catch(() => {});
  await client.query("DELETE FROM data.instances WHERE run_id=$1", [ids.run]).catch(() => {});
  await client.query("DELETE FROM data.runs WHERE run_id=$1", [ids.run]).catch(() => {});
  await client.query("DELETE FROM control.channel_space_routes WHERE space_id=ANY($1)", [[ids.home, ids.target]])
    .catch(() => {});
  for (const table of ["channels", "space_members", "spaces"]) {
    await client.query(`DELETE FROM data.${table} WHERE space_id=ANY($1)`, [[ids.home, ids.target]]).catch(() => {});
  }
  await client.query("DELETE FROM control.space_placement WHERE space_id=ANY($1)", [[ids.home, ids.target]])
    .catch(() => {});
}

function proofOf(ids, executionKey = "execution-1") {
  // An Agent principal is its live Instance.
  return { agentId: ids.instance, runId: ids.run, instanceId: ids.instance, executionKey,
    channelId: ids.source, spaceId: ids.home };
}

const code = (expected) => (error) => error.code === expected;

integration("a Run reads another Space only through its owner's approved grant, as its owner", async () => {
  await withCrossSpaceFixture(async ({ client, ids, repository, proof }) => {
    const read = (channelId) => repository.authorizeRead({ requestId: crypto.randomUUID(), proof, channelId });

    assert.equal(await read(ids.source), null, "the Run's own Space is the ordinary Agent path");
    await assert.rejects(read(ids.debug), code("cross_space_read_grant_required"),
      "no grant, no read, even though the owner could read it");

    const { grant, created } = await repository.request({ requestId: crypto.randomUUID(), proof,
      channelId: ids.debug, scope: "channel", reason: "debug a launch" });
    assert.equal(created, true);
    assert.equal(grant.status, "pending");
    assert.equal(grant.ownerUserId, ids.owner);
    const again = await repository.request({ requestId: crypto.randomUUID(), proof,
      channelId: ids.debug, scope: "channel" });
    assert.deepEqual([again.created, again.grant.id], [false, grant.id], "a retry reuses the open request");
    await assert.rejects(read(ids.debug), code("cross_space_read_grant_required"), "pending is not approved");

    const waiting = (viewer) => repository.pendingForChannel({ requestId: crypto.randomUUID(),
      channelId: ids.source, viewerUserId: viewer });
    assert.deepEqual((await waiting(ids.owner)).map((pending) => pending.id), [grant.id],
      "the Run's own Channel lists the request waiting for its owner, however old its card is");
    assert.deepEqual(await waiting(ids.teammate), [], "a teammate has nothing to decide there");

    await assert.rejects(repository.decide({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: grant.id, ownerUserId: ids.teammate, action: "approve" }), code("grant_not_found"),
    "a teammate who can prompt the Agent cannot approve its owner's grant");
    await assert.rejects(repository.decide({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: grant.id, ownerUserId: ids.owner, action: "approve", scope: "space" }),
    code("scope_widening_forbidden"));
    const approved = await repository.decide({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: grant.id, ownerUserId: ids.owner, action: "approve" });
    assert.equal(approved.status, "approved");
    assert.deepEqual(await waiting(ids.owner), [], "a decided request leaves the list");
    assert.ok(Date.parse(approved.expiresAt) - Date.now() <= 24 * 60 * 60_000);

    assert.deepEqual(await read(ids.debug), { ownerUserId: ids.owner, spaceId: ids.target, grantId: grant.id });
    assert.equal((await read(ids.thread)).grantId, grant.id, "a Channel grant covers its threads");
    await assert.rejects(read(ids.sibling), code("cross_space_read_grant_required"),
      "a Channel grant does not cover the rest of its Space");
    await assert.rejects(repository.authorizeRead({ requestId: crypto.randomUUID(), proof, spaceId: ids.target }),
      code("cross_space_read_grant_required"), "nor a Space-wide catalog");
    const used = await repository.read({ requestId: crypto.randomUUID(), spaceId: ids.target, grantId: grant.id,
      principal: { kind: "user", id: ids.owner } });
    assert.equal(used.readCount, 2, "every granted read is counted on the grant");

    await assert.rejects(repository.authorizeRead({ requestId: crypto.randomUUID(),
      proof: proofOf(ids, "execution-2"), channelId: ids.debug }), code("agent_run_forbidden"),
    "a stale execution key is not the live Run");
    await client.query(`UPDATE data.runs SET metadata_json='{"executionKey":"execution-2"}' WHERE run_id=$1`, [ids.run]);
    await assert.rejects(repository.authorizeRead({ requestId: crypto.randomUUID(),
      proof: proofOf(ids, "execution-2"), channelId: ids.debug }), code("cross_space_read_grant_required"),
    "a new execution of the same Run does not inherit the grant");
    await client.query(`UPDATE data.runs SET metadata_json='{"executionKey":"execution-1"}' WHERE run_id=$1`, [ids.run]);

    await repository.decide({ requestId: crypto.randomUUID(), spaceId: ids.target, grantId: grant.id,
      ownerUserId: ids.owner, action: "revoke" });
    await assert.rejects(read(ids.debug), code("cross_space_read_grant_required"), "revocation is immediate");

    const space = await repository.request({ requestId: crypto.randomUUID(), proof,
      channelId: ids.debug, scope: "space" });
    await repository.decide({ requestId: crypto.randomUUID(), spaceId: ids.target, grantId: space.grant.id,
      ownerUserId: ids.owner, action: "approve" });
    assert.equal((await read(ids.sibling)).grantId, space.grant.id);
    assert.equal((await repository.authorizeRead({ requestId: crypto.randomUUID(), proof,
      spaceId: ids.target })).ownerUserId, ids.owner);
    await assert.rejects(read(ids.secret), code("channel_not_found"),
      "a Space grant never reaches a Channel its owner cannot read");

    await client.query("UPDATE data.runs SET status='finished' WHERE run_id=$1", [ids.run]);
    await assert.rejects(read(ids.sibling), code("agent_run_forbidden"), "the grant ends with the Run");
  });
});

integration("an owner may narrow a Space request to its Channel, and deny ends it", async () => {
  await withCrossSpaceFixture(async ({ ids, repository, proof }) => {
    await assert.rejects(repository.request({ requestId: crypto.randomUUID(), proof,
      channelId: ids.secret, scope: "channel" }), code("channel_not_found"),
    "a Channel the owner cannot read cannot even be asked for");
    await assert.rejects(repository.request({ requestId: crypto.randomUUID(), proof,
      channelId: ids.source, scope: "channel" }), code("same_space"));

    const { grant } = await repository.request({ requestId: crypto.randomUUID(), proof,
      channelId: ids.debug, scope: "space" });
    const narrowed = await repository.decide({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: grant.id, ownerUserId: ids.owner, action: "approve", scope: "channel" });
    assert.equal(narrowed.scope, "channel");
    await assert.rejects(repository.authorizeRead({ requestId: crypto.randomUUID(), proof,
      channelId: ids.sibling }), code("cross_space_read_grant_required"));

    const denied = await repository.request({ requestId: crypto.randomUUID(), proof,
      channelId: ids.sibling, scope: "channel" });
    const closed = await repository.decide({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: denied.grant.id, ownerUserId: ids.owner, action: "deny" });
    assert.equal(closed.status, "denied");
    await assert.rejects(repository.decide({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: denied.grant.id, ownerUserId: ids.owner, action: "approve" }), code("grant_not_pending"));

    const status = await repository.read({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: grant.id, principal: { kind: "agent", proof } });
    assert.equal(status.status, "approved", "the requesting Run may poll its own grant");
    await assert.rejects(repository.read({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: grant.id, principal: { kind: "user", id: ids.teammate } }), code("grant_not_found"));
  });
});

integration("a person hands a conversation to support: only to support, only what they ticked, as them", async () => {
  await withCrossSpaceFixture(async ({ client, ids, database: db }) => {
    const repository = new PostgresSupportHandoffRepository(db);
    const supportMember = { kind: "user", id: ids.owner };
    const handOff = (userId, parts, extra = {}) => repository.handOff({ requestId: crypto.randomUUID(), userId,
      channelId: ids.mine, supportSpaceId: ids.home, line: "the agent never answers", parts, ...extra });
    const supportRead = (grantId, part, reader = supportMember) => repository.authorizeHandoffRead({
      requestId: crypto.randomUUID(), spaceId: ids.target, grantId, reader, part });
    const run = (channelId) => ({ ...proofOf(ids), channelId });
    const runRead = (proof, part = "messages", channelId = ids.mine) => repository.authorizeRead({
      requestId: crypto.randomUUID(), proof, channelId, part });

    await assert.rejects(runRead(run(ids.source)), code("cross_space_read_grant_required"),
      "with no handoff support reads nothing");
    await assert.rejects(handOff(`${ids.customer}-stranger`, []), code("channel_not_found"));
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$2,'member',1,now(),now())`, [ids.target, ids.teammate]);
    await assert.rejects(handOff(ids.teammate, ["messages"]), code("support_handoff_forbidden"),
      "a member who did not start the conversation cannot hand it over for its creator");

    const { handoff, supportOwnerUserId } = await handOff(ids.customer, ["messages"]);
    assert.equal(supportOwnerUserId, ids.owner);
    assert.deepEqual([handoff.status, handoff.parts, handoff.ownerUserId, handoff.supportSpaceId],
      ["approved", ["messages"], ids.customer, ids.home]);
    assert.equal((Date.parse(handoff.expiresAt) - Date.parse(handoff.requestedAt)) / 86_400_000, 14);

    const first = await supportRead(handoff.id, "messages");
    assert.equal(first.handoff.channelId, ids.mine);
    assert.equal(first.accessNote.channelId, ids.mine, "the first read tells the person's conversation");
    assert.deepEqual([first.accessNote.reads, first.accessNote.notedAt], [1, first.accessNote.latestAt]);
    const second = await supportRead(handoff.id, "messages");
    assert.deepEqual([second.accessNote.reads, second.accessNote.notedAt], [2, first.accessNote.notedAt],
      "a later read in the hour counts in the same note");
    await assert.rejects(supportRead(handoff.id, "diagnostics"), code("support_handoff_part_not_shared"));
    await assert.rejects(supportRead(handoff.id, "logs"), code("support_handoff_part_not_shared"));
    for (const reader of [{ kind: "user", id: ids.customer }, { kind: "user", id: ids.viewer },
      { kind: "user", id: `${ids.owner}-stranger` }]) {
      await assert.rejects(supportRead(handoff.id, "messages", reader), code("support_handoff_not_found"),
        "only support's members read a handoff, never a viewer or anyone else");
    }

    await assert.rejects(runRead(run(ids.source)), code("cross_space_read_grant_required"),
      "a support Run outside the handoff's conversation reads nothing");
    const working = await supportRun(client, ids, handoff.supportChannelId);
    const { accessNote, ...asPerson } = await runRead(working);
    assert.deepEqual(asPerson, { ownerUserId: ids.customer, spaceId: ids.target, grantId: handoff.id },
      "the Run working in the support conversation reads as the person");
    assert.equal(accessNote.reads, 3, "the Run's read is shown in the hour's note too");
    const context = () => repository.authorizeRead({ requestId: crypto.randomUUID(), proof: working,
      channelId: ids.mine, part: "messages", alongside: true });
    assert.deepEqual(await context(), { ownerUserId: ids.customer, spaceId: ids.target, grantId: handoff.id },
      "the Channel's name and threads, read beside its messages, go through the same handoff");
    const counted = (await client.query("SELECT read_count,access_note_reads FROM data.cross_space_read_grants WHERE grant_id=$1",
      [handoff.id])).rows[0];
    assert.deepEqual([Number(counted.read_count), counted.access_note_reads], [3, 3], "and are not a second read");
    await assert.rejects(repository.authorizeRead({ requestId: crypto.randomUUID(), proof: working,
      channelId: ids.mine }), code("cross_space_read_grant_required"),
    "a read that is not the conversation's messages is not covered");
    await assert.rejects(runRead(working, "messages", ids.sibling), code("cross_space_read_grant_required"),
      "nor is any other conversation in the person's Space");

    await assert.rejects(repository.revokeHandoff({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: handoff.id, userId: ids.teammate }), code("support_handoff_not_found"));
    const revoked = await repository.revokeHandoff({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: handoff.id, userId: ids.customer });
    assert.equal(revoked.status, "revoked");
    await assert.rejects(supportRead(handoff.id, "messages"), code("support_handoff_ended"), "withdrawal is immediate");
    await assert.rejects(runRead(working), code("cross_space_read_grant_required"));
    await assert.rejects(context(), code("cross_space_read_grant_required"), "nor the Channel's context");
    await assert.rejects(repository.authorizeHandoffReply({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: handoff.id, reader: supportMember }), code("support_handoff_ended"));
  });
});

integration("diagnostics and logs are read only as ticked, and expiry or an admin ends a handoff", async () => {
  await withCrossSpaceFixture(async ({ client, ids, database: db }) => {
    const repository = new PostgresSupportHandoffRepository(db);
    const supportMember = { kind: "user", id: ids.owner };
    await client.query(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,$3,'failed',1,'{"executionKey":"secret-key","prompt":"private words"}',now(),now())`,
    [`${ids.mine}:1#1`, ids.customer, ids.mine]);
    await assert.rejects(repository.handOff({ requestId: crypto.randomUUID(), userId: ids.customer,
      channelId: ids.mine, supportSpaceId: ids.home, line: "logs", parts: ["logs"] }), code("invalid_request"),
    "logs are never handed over without the excerpt the person previewed");
    await assert.rejects(repository.handOff({ requestId: crypto.randomUUID(), userId: ids.customer,
      channelId: ids.mine, supportSpaceId: ids.target, line: "same", parts: [] }), code("same_space"));
    const { handoff } = await repository.handOff({ requestId: crypto.randomUUID(), userId: ids.customer,
      channelId: ids.mine, supportSpaceId: ids.home, line: "it crashed", parts: ["diagnostics", "logs"],
      logExcerpt: "error: spawn failed at ~/…" });
    const read = (part) => repository.authorizeHandoffRead({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: handoff.id, reader: supportMember, part });

    const { diagnostics } = await read("diagnostics");
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(Object.keys(diagnostics[0]).sort(), ["createdAt", "kind", "status"],
      "only allowlisted fields: no ids, no execution key, no prompt");
    assert.equal(diagnostics[0].status, "failed");
    assert.equal((await read("logs")).logExcerpt, "error: spawn failed at ~/…");
    await assert.rejects(read("messages"), code("support_handoff_part_not_shared"),
      "the conversation's messages were not ticked");

    await client.query("UPDATE data.cross_space_read_grants SET expires_at=now()-interval '1 second' WHERE grant_id=$1",
      [handoff.id]);
    await assert.rejects(read("logs"), code("support_handoff_ended"), "expiry ends reads at once");
    assert.equal((await repository.readHandoff({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: handoff.id, viewer: { kind: "user", id: ids.customer } })).status, "expired");

    const second = await repository.handOff({ requestId: crypto.randomUUID(), userId: ids.customer,
      channelId: ids.mine, supportSpaceId: ids.home, line: "again", parts: ["logs"], logExcerpt: "tail" });
    const lapsed = (await client.query("SELECT status,log_excerpt FROM data.cross_space_read_grants WHERE grant_id=$1",
      [handoff.id])).rows[0];
    assert.deepEqual({ ...lapsed }, { status: "expired", log_excerpt: null }, "a lapsed handoff's logs are erased");
    const byAdmin = await repository.revokeHandoff({ requestId: crypto.randomUUID(), spaceId: ids.target,
      grantId: second.handoff.id, userId: ids.admin });
    assert.equal(byAdmin.status, "revoked", "an admin of the person's Space may withdraw it too");
    const erased = (await client.query("SELECT log_excerpt FROM data.cross_space_read_grants WHERE grant_id=$1",
      [second.handoff.id])).rows[0];
    assert.equal(erased.log_excerpt, null);
  });
});

integration("every support read is shown: one note an hour that counts its reads, a new note the next hour",
  async () => {
    await withCrossSpaceFixture(async ({ client, ids, database: db }) => {
      const repository = new PostgresSupportHandoffRepository(db);
      const { handoff } = await repository.handOff({ requestId: crypto.randomUUID(), userId: ids.customer,
        channelId: ids.mine, supportSpaceId: ids.home, line: "slow replies", parts: ["messages"] });
      const read = async () => (await repository.authorizeHandoffRead({ requestId: crypto.randomUUID(),
        spaceId: ids.target, grantId: handoff.id, reader: { kind: "user", id: ids.owner }, part: "messages" }))
        .accessNote;

      const notes = [await read(), await read(), await read()];
      assert.equal(new Set(notes.map((note) => note.notedAt)).size, 1, "three reads in one hour, one note");
      assert.deepEqual(notes.map((note) => note.reads), [1, 2, 3]);
      const latest = notes[2].latestAt;
      assert.equal(supportAccessNoteBody(notes[2]),
        `xMatrix support read this conversation 3 times (latest ${latest.slice(11, 16)} UTC).`,
        "the note shows every read and the latest one's time");
      const stored = (await client.query(`SELECT read_count,last_read_at,access_note_reads
        FROM data.cross_space_read_grants WHERE grant_id=$1`, [handoff.id])).rows[0];
      assert.deepEqual([Number(stored.read_count), stored.access_note_reads, stored.last_read_at.toISOString()], [3, 3, latest]);

      // The hour passes.
      await client.query(`UPDATE data.cross_space_read_grants
        SET access_noted_at=access_noted_at-interval '61 minutes' WHERE grant_id=$1`, [handoff.id]);
      const next = await read();
      assert.notEqual(next.notedAt, notes[0].notedAt, "the next hour's read starts a second note");
      assert.deepEqual([next.reads, next.notedAt], [1, next.latestAt]);
      assert.equal(supportAccessNoteBody(next),
        `xMatrix support read this conversation (${next.latestAt.slice(0, 16).replace("T", " ")} UTC).`);
    });
  });

/** A live Run working in the support conversation a handoff opened. */
async function supportRun(client, ids, channelId) {
  const instanceId = `${channelId}:1`;
  const runId = `${instanceId}#1`;
  await client.query(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,$3,'running',1,'{"executionKey":"support-1"}',now(),now())`, [runId, ids.owner, channelId]);
  await client.query(`INSERT INTO data.instances
    (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
    VALUES ($1,$2,$3,1,'online',1,now(),now())`, [instanceId, runId, channelId]);
  await client.query(`INSERT INTO control.entity_space_routes
    (entity_kind,entity_id,space_id,shard_id,placement_epoch,entity_version,route_version,state,updated_at)
    VALUES ('run',$1,$2,'shard-0',1,1,1,'active',now())`, [runId, ids.home]);
  ids.supportRuns.push(runId);
  return { agentId: instanceId, runId, instanceId, executionKey: "support-1", channelId, spaceId: ids.home };
}

async function crossSpaceClient() {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function crossSpaceFixture(client) {
  const ids = await fixture(client, `csr-${crypto.randomUUID()}`);
  // The Run executes under its Space Agent Registration, which this file does not exercise.
  const real = database(client);
  const db = { ...real, transaction: (context, callback) => real.transaction(context, (tx) => callback({
    query: async (query) => registeredRunRows(query, { runId: ids.run, spaceId: ids.home, ownerUserId: ids.owner })
      ?? tx.query(query) })) };
  return { ids, database: db, repository: new PostgresCrossSpaceReadRepository(db), proof: proofOf(ids) };
}

async function withCrossSpaceFixture(body) {
  const client = await crossSpaceClient();
  let ids = { home: "", target: "", run: "", agent: "" };
  try {
    const seeded = await crossSpaceFixture(client);
    ids = seeded.ids;
    return await body({ client, ...seeded });
  } finally { await cleanup(client, ids); await client.end(); }
}
