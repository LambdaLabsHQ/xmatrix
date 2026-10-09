import { connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";

import { Client } from "pg";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { createAuthorityDatabase, PostgresFirstMessageLaunchChoiceRepository, readFirstMessageLaunchChoices } from "../dist/index.js";


/** A registration of `harness` in the Space that routing may use, owned by a member. */
async function routableHarness(client, space, harness, { grant = "active", routing = true } = {}) {
  const owner = `${space}:owner`, machine = `${space}:machine`;
  const limits = JSON.stringify({ workspaces: [], models: [], secrets: [], capabilities: [] });
  await client.query(`INSERT INTO data.spaces
    (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,'First launch',$1,1,'{}',now(),now()) ON CONFLICT DO NOTHING`, [space, owner]);
  await client.query(`INSERT INTO data.space_members
    (space_id,user_id,role,version,email,display_name,created_at,updated_at)
    VALUES ($1,$2,'owner',1,'owner@example.test','Owner',now(),now()) ON CONFLICT DO NOTHING`, [space, owner]);
  await client.query(`INSERT INTO data.agent_registrations (owner_user_id,machine_id,harness,version,created_at,updated_at)
    VALUES ($1,$2,$3,1,now(),now()) ON CONFLICT DO NOTHING`, [owner, machine, harness]);
  await client.query(`INSERT INTO data.space_agent_registrations
    (space_id,owner_user_id,machine_id,harness,display_name,configuration_json,version,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$4,$5::jsonb,1,now(),now())`,
  [space, owner, machine, harness, JSON.stringify(routing ? {} : { routing: { enabled: false } })]);
  await client.query(`INSERT INTO data.space_agent_registration_access
    (space_id,owner_user_id,machine_id,harness,grant_state,grant_revision,grant_limits,
     policy_state,policy_revision,policy_limits,updated_at)
    VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,'enabled',1,$6::jsonb,now())`, [space, owner, machine, harness, grant, limits]);
}

async function removeSpace(client, space) {
  for (const table of ["first_message_launch_choices", "messages", "space_agent_registration_access",
    "space_agent_registrations", "space_members"]) await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [space]);
  await client.query("DELETE FROM data.agent_registrations WHERE owner_user_id=$1", [`${space}:owner`]);
  await client.query("DELETE FROM data.spaces WHERE space_id=$1", [space]);
  await client.query("DELETE FROM control.space_placement WHERE space_id=$1", [space]);
}

async function firstLaunchFixture() {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const prefix = `first-launch:${crypto.randomUUID()}`;
  const space = `${prefix}:space`, channel = `${prefix}:channel`;
  const client = new Client({ connectionString });
  await client.connect();
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0",
    applicationName: "xmatrix-first-launch-regression", statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000 });
  const placement = { spaceId: space, shardId: "shard-0", placementEpoch: 1 };
  return { space, channel, client, database, placement,
    choices: new PostgresFirstMessageLaunchChoiceRepository(database, placement) };
}

integration("a first message's launch is decided once: the author within the window, else Jev after it", async () => {
  const { space, channel, client, database, placement, choices } = await firstLaunchFixture();
  const body = "fix the flaky login test";
  const bodyHash = await digestCanonicalCloneCborV1(body);
  const message = (id, sequence, sentAt) => client.query(`INSERT INTO data.messages
    (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,content_hash,
     payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence,body_hash)
    VALUES ($1,$2,$3,$4,1,'user','author','message','hash','inline','ref',$5,$5,$5,$3,$6)`,
  [space, channel, id, sequence, sentAt, bodyHash]);
  const read = async ids => database.transaction({ requestId: "read", operation: "test.read", placement },
    tx => readFirstMessageLaunchChoices(tx, channel, ids));
  try {
    await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [space]);
    await routableHarness(client, space, "claude");
    const now = Date.now();
    await message("open", 1, new Date(now).toISOString());
    await message("later", 2, new Date(now).toISOString());

    // The author picks while Jev is still reading; Jev's later claim loses.
    // Until Jev has read it, only the hold limit bounds the window.
    const window = await choices.open({ requestId: "open", channelId: channel, messageId: "open", authorUserId: "author" });
    assert.equal(Date.parse(window.deadlineAt), now + 30_000);
    // Jev's reading starts the author's window: three seconds once they see it, which takes up to 1.5s.
    const before = Date.now();
    const reading = Date.parse((await choices.recommend({ requestId: "rec", channelId: channel, messageId: "open", harness: "codex" })).deadlineAt);
    assert.ok(reading >= before + 4_400 && reading <= Date.now() + 4_600, `reading deadline ${reading - before}ms ahead`);
    assert.equal(Date.parse((await choices.recommend({ requestId: "rec-again", channelId: channel, messageId: "open" })).deadlineAt), reading,
      "the reading is written once");
    assert.equal((await read(["open"]))[0].open, true);
    // The rest does not depend on how fast this host runs.
    await client.query(`UPDATE data.first_message_launch_choices SET deadline_at=clock_timestamp()+interval '1 minute'
      WHERE channel_id=$1`, [channel]);
    await assert.rejects(choices.claim({ requestId: "early", channelId: channel, messageId: "open", by: "jev",
      actorUserId: "author", harness: "codex" }), error => error.code === "launch_choice_window_open");
    await assert.rejects(choices.claim({ requestId: "stranger", channelId: channel, messageId: "open", by: "author",
      actorUserId: "someone-else", harness: "claude", body }), error => error.code === "launch_choice_forbidden");
    await assert.rejects(choices.claim({ requestId: "stale", channelId: channel, messageId: "open", by: "author",
      actorUserId: "author", harness: "claude", body: "another body" }), error => error.code === "launch_choice_stale");
    assert.deepEqual(await choices.claim({ requestId: "pick", channelId: channel, messageId: "open", by: "author",
      actorUserId: "author", harness: "claude", body }), { claimed: true });
    assert.deepEqual(await choices.claim({ requestId: "again", channelId: channel, messageId: "open", by: "author",
      actorUserId: "author", body }), { claimed: false }, "a second pick never overrides the first");
    await client.query(`UPDATE data.first_message_launch_choices SET deadline_at=now()-interval '1 second'
      WHERE channel_id=$1`, [channel]);
    assert.deepEqual(await choices.claim({ requestId: "late", channelId: channel, messageId: "open", by: "jev",
      actorUserId: "author", harness: "codex" }), { claimed: false });
    assert.equal((await choices.open({ requestId: "reopen", channelId: channel, messageId: "open", authorUserId: "author" })).chosenBy, "author");
    // xMatrix's summon of the decided harness launches as the author, and only as the author.
    const { messageAuthoredForActor } = await import("../dist/message-invocation-selections.js");
    const authored = (actorUserId, messageId = "xmatrix-summon:open", authorId = "xmatrix") =>
      database.transaction({ requestId: `authored:${actorUserId}:${messageId}`, operation: "test", placement }, tx =>
        messageAuthoredForActor(tx, { spaceId: space, channelId: channel, messageId, authorKind: "system", authorId, actorUserId }));
    assert.equal(await authored("author"), true);
    assert.equal(await authored("someone-else"), false);
    assert.equal(await authored("author", "xmatrix-summon:later"), false, "no decision to start on that message");
    assert.equal(await authored("author", "xmatrix-summon:open", "other-system"), false);
    // The summon is the launch's source message, so routing and the Run read it as the author's.
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,content_hash,
       payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence,body_hash)
      VALUES ($1,$2,'xmatrix-summon:open',3,1,'system','xmatrix','message','hash','inline','ref',now(),now(),now(),'s',$3)`,
    [space, channel, bodyHash]);
    const { initialMessageSource } = await import("../dist/runtime-initial-input.js");
    const source = actorUserId => database.transaction({ requestId: `source:${actorUserId}`, operation: "test", placement }, tx =>
      initialMessageSource(tx, { spaceId: space, channelId: channel, messageId: "xmatrix-summon:open", actorUserId }));
    assert.equal((await source("author"))?.sequence, 3);
    assert.equal(await source("someone-else"), undefined);
    // Jev failing after the author decided changes nothing.
    await choices.fail({ requestId: "fail", channelId: channel, messageId: "open", failureCode: "registration_not_found" });
    const [picked] = await read(["open", "missing"]);
    assert.deepEqual({ ...picked, choice: { ...picked.choice, at: "at" } }, { channelId: channel, messageId: "open",
      deadlineAt: picked.deadlineAt, open: false, recommendation: { start: true, harness: "codex" },
      choice: { start: true, harness: "claude", by: "author", at: "at" } });

    // Only the Channel's first message offers a choice.
    await assert.rejects(choices.open({ requestId: "second", channelId: channel, messageId: "later", authorUserId: "author" }),
      error => error.code === "launch_choice_unavailable");
  } finally {
    await removeSpace(client, space);
    await client.end();
  }
});

integration("Jev's own decision after an unchosen window is idempotent and 'none' starts nothing", async () => {
  const { space, channel, client, database, placement, choices } = await firstLaunchFixture();
  try {
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [space]);
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,content_hash,
       payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence)
      VALUES ($1,$2,'m',1,1,'user','author','message','hash','inline','ref',now()-interval '40 seconds',now(),now(),'m')`,
    [space, channel]);
    await choices.open({ requestId: "open", channelId: channel, messageId: "m", authorUserId: "author" });
    await choices.recommend({ requestId: "rec", channelId: channel, messageId: "m" });
    const jev = { channelId: channel, messageId: "m", by: "jev", actorUserId: "author" };
    assert.deepEqual(await choices.claim({ requestId: "claim", ...jev }), { claimed: true });
    assert.deepEqual(await choices.claim({ requestId: "retry", ...jev }), { claimed: true });
    assert.deepEqual(await choices.claim({ requestId: "author", channelId: channel, messageId: "m", by: "author",
      actorUserId: "author", harness: "codex" }).catch(error => error.code), "launch_choice_stale");
    const [none] = await database.transaction({ requestId: "read", operation: "test.read", placement },
      tx => readFirstMessageLaunchChoices(tx, channel, ["m"]));
    assert.deepEqual(none.recommendation, { start: false });
    assert.equal(none.choice.start, false);
    assert.equal(none.choice.by, "jev");
  } finally {
    await removeSpace(client, space);
    await client.end();
  }
});

integration("an author who sees Jev's reading late gets the whole window from then, but never past the hold limit", async () => {
  const { space, channel, client, choices } = await firstLaunchFixture();
  const body = "start on the release notes";
  const bodyHash = await digestCanonicalCloneCborV1(body);
  const message = (id, ageMs) => client.query(`INSERT INTO data.messages
    (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,content_hash,
     payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence,body_hash)
    VALUES ($1,$2||$3,$3,1,1,'user','author','message','hash','inline','ref',now()-make_interval(secs => $4::double precision/1000),now(),now(),$3,$5)`,
  [space, channel, id, ageMs, bodyHash]);
  const where = id => ({ channelId: channel + id, messageId: id });
  const show = id => choices.show({ requestId: `show-${id}`, ...where(id), actorUserId: "author", body });
  try {
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [space]);
    await message("late", 2_500);
    await message("stale", 29_000);
    for (const id of ["late", "stale"]) {
      await choices.open({ requestId: `open-${id}`, ...where(id), authorUserId: "author" });
      await choices.recommend({ requestId: `rec-${id}`, ...where(id), harness: "codex" });
    }
    // Seen 2s after the reading was written: three seconds from then.
    await client.query("UPDATE data.first_message_launch_choices SET deadline_at=clock_timestamp()+interval '2.5 seconds' WHERE channel_id=$1",
      [channel + "late"]);
    const before = Date.now();
    const late = Date.parse((await show("late")).deadlineAt);
    assert.ok(late >= before + 2_900 && late <= Date.now() + 3_100, `deadline ${late - before}ms ahead`);
    // Seen 29s after sending: capped at sending + 30s.
    const stale = Date.parse((await show("stale")).deadlineAt);
    assert.ok(stale <= Date.now() + 1_100, `capped deadline ${stale - Date.now()}ms ahead`);
    await assert.rejects(choices.show({ requestId: "x", ...where("late"), actorUserId: "other", body }),
      error => error.code === "launch_choice_forbidden");
    // A delayed author request cannot steal the decision after the DB deadline,
    // even when Jev has not claimed yet. No wall-clock sleep is needed.
    await client.query("UPDATE data.first_message_launch_choices SET deadline_at=clock_timestamp()-interval '1 second' WHERE channel_id=$1",
      [channel + "stale"]);
    const [lateAuthor, jev] = await Promise.all([
      choices.claim({ requestId: "late-author", ...where("stale"), by: "author", actorUserId: "author", harness: "claude", body }),
      choices.claim({ requestId: "jev-after-deadline", ...where("stale"), by: "jev", actorUserId: "author", harness: "codex" }),
    ]);
    assert.deepEqual(lateAuthor, { claimed: false });
    assert.deepEqual(jev, { claimed: true });
    // Once decided, seeing it again moves nothing.
    const [{ deadline_at: held }] = (await client.query(`UPDATE data.first_message_launch_choices
      SET deadline_at=clock_timestamp()+interval '1 minute' WHERE channel_id=$1 RETURNING deadline_at`, [channel + "late"])).rows;
    assert.deepEqual(await choices.claim({ requestId: "pick", ...where("late"), by: "author", actorUserId: "author", body }), { claimed: true });
    assert.equal(Date.parse((await show("late")).deadlineAt), held.getTime());
  } finally {
    await removeSpace(client, space);
    await client.end();
  }
});

integration("an author's pick must name a harness the Space can route now, and a refused pick writes nothing", async () => {
  const { space, channel, client, choices } = await firstLaunchFixture();
  const body = "triage the crash report";
  const bodyHash = await digestCanonicalCloneCborV1(body);
  const pick = (requestId, harness) => choices.claim({ requestId, channelId: channel, messageId: "m", by: "author",
    actorUserId: "author", body, ...(harness ? { harness } : {}) });
  const row = async () => (await client.query(
    "SELECT choice,chosen_harness FROM data.first_message_launch_choices WHERE channel_id=$1", [channel])).rows[0];
  try {
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [space]);
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,content_hash,
       payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence,body_hash)
      VALUES ($1,$2,'m',1,1,'user','author','message','hash','inline','ref',now(),now(),now(),'m',$3)`,
    [space, channel, bodyHash]);
    await routableHarness(client, space, "claude");
    await routableHarness(client, space, "gemini", { grant: "revoked" });
    await routableHarness(client, space, "codex", { routing: false });
    for (const harness of ["grok", "gemini", "codex"]) {
      await assert.rejects(pick(`refused-${harness}`, harness), error => error.code === "launch_choice_harness_unavailable", harness);
      assert.equal(await row(), undefined, `${harness}: a refused pick writes no choice`);
    }
    assert.deepEqual(await pick("pick", "claude"), { claimed: true });
    // The winning request's retry is answered by the decision written, even
    // once the registration it named has been revoked.
    await client.query("UPDATE data.space_agent_registration_access SET grant_state='revoked' WHERE space_id=$1", [space]);
    assert.deepEqual(await pick("pick-retry", "claude"), { claimed: true });
    assert.deepEqual(await row(), { choice: "start", chosen_harness: "claude" });
  } finally {
    await removeSpace(client, space);
    await client.end();
  }
});


integration("an Agent's first message persists an immediate owner-bound decision authorizing exactly one summon", async () => {
  const { space, channel, client, database, placement, choices } = await firstLaunchFixture();
  const owner = `${space}:owner`, instance = `${channel}:1`, run = `${instance}#1`;
  const body = "start an agent to inspect the release notes";
  const bodyHash = await digestCanonicalCloneCborV1(body);
  const where = { channelId: channel, messageId: "agent-first" };
  try {
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [space]);
    await routableHarness(client, space, "codex");
    await client.query(`INSERT INTO data.runs
      (run_id,owner_user_id,channel_id,workspace_machine_id,workspace_canonical_cwd,status,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'/tmp/test','running',1,'{}',now(),now())`, [run, owner, channel, `${space}:machine`]);
    await client.query(`INSERT INTO data.instances
      (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ($1,$2,$3,1,'online',1,now(),now())`, [instance, run, channel]);
    await client.query(`INSERT INTO data.run_agent_registrations
      (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
       grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
      VALUES ($1,$2,$3,$4,'codex',$3,$1,repeat('a',64),1,1,1,1,'{}')`, [run, space, owner, `${space}:machine`]);
    await client.query(`INSERT INTO data.messages
      (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,message_kind,content_hash,
       payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence,body_hash)
      VALUES ($1,$2,'agent-first',1,1,'agent',$3,'message','hash','inline','ref',now(),now(),now(),'m',$4)`,
    [space, channel, instance, bodyHash]);
    await assert.rejects(choices.open({ requestId: "stranger", ...where, authorUserId: "stranger" }),
      error => error.code === "launch_choice_forbidden");
    await client.query("UPDATE data.messages SET author_id='unbound-instance' WHERE channel_id=$1", [channel]);
    await assert.rejects(choices.open({ requestId: "unbound", ...where, authorUserId: owner }),
      error => error.code === "launch_choice_forbidden");
    await client.query("UPDATE data.messages SET author_id=$2,edited_at=now() WHERE channel_id=$1", [channel, instance]);
    await assert.rejects(choices.open({ requestId: "edited", ...where, authorUserId: owner }),
      error => error.code === "launch_choice_unavailable");
    await client.query("UPDATE data.messages SET edited_at=NULL WHERE channel_id=$1", [channel]);
    assert.equal((await client.query("SELECT 1 FROM data.first_message_launch_choices WHERE channel_id=$1", [channel])).rowCount, 0);
    const opened = await choices.open({ requestId: "open", ...where, authorUserId: owner });
    assert.ok(Date.parse(opened.deadlineAt) <= Date.now(), "no Human picker window for an Agent");
    // The owner cannot claim an Agent publication through the Human picker.
    await assert.rejects(choices.show({ requestId: "show", ...where, actorUserId: owner, body }),
      error => error.code === "launch_choice_forbidden");
    await assert.rejects(choices.claim({ requestId: "pick", ...where, by: "author", actorUserId: owner, body, harness: "codex" }),
      error => error.code === "launch_choice_forbidden");
    await choices.recommend({ requestId: "recommend", ...where, harness: "codex" });
    const claim = { ...where, by: "jev", actorUserId: owner, harness: "codex" };
    const results = await Promise.all([choices.claim({ requestId: "claim", ...claim }), choices.claim({ requestId: "retry", ...claim })]);
    assert.deepEqual(results, [{ claimed: true }, { claimed: true }]);
    assert.deepEqual(await choices.claim({ requestId: "stranger-replay", ...claim, actorUserId: "stranger" }), { claimed: false });
    assert.deepEqual(await choices.claim({ requestId: "different", ...claim, harness: "claude" }), { claimed: false });
    const { messageAuthoredForActor } = await import("../dist/message-invocation-selections.js");
    const authorized = actorUserId => database.transaction({ requestId: "summon", operation: "test", placement }, tx =>
      messageAuthoredForActor(tx, { spaceId: space, channelId: channel, messageId: "xmatrix-summon:agent-first",
        authorKind: "system", authorId: "xmatrix", actorUserId }));
    assert.equal(await authorized(owner), true, "the persisted decision authorizes the system summon");
    assert.equal(await authorized("stranger"), false);
    const [decision] = await database.transaction({ requestId: "read", operation: "test", placement }, tx =>
      readFirstMessageLaunchChoices(tx, channel, [where.messageId]));
    assert.equal(decision.open, false);
    assert.equal(decision.choice.harness, "codex");
    assert.equal(decision.choice.by, "jev");
  } finally {
    await client.query("DELETE FROM data.instances WHERE instance_id=$1", [instance]);
    await client.query("DELETE FROM data.run_agent_registrations WHERE run_id=$1", [run]);
    await client.query("DELETE FROM data.runs WHERE run_id=$1", [run]);
    await removeSpace(client, space);
    await client.end();
  }
});
