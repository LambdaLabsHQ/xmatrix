import assert from "node:assert/strict";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { createAuthorityDatabase, PostgresMessageAskRepository, PostgresFirstMessageLaunchChoiceRepository,
  readMessageAsks, readDueFirstMessageSummons } from "../dist/index.js";
import { recordMessageAskAtAppend } from "../dist/message-asks.js";
import { messageAuthoredForActor } from "../dist/message-invocation-selections.js";
import { fenceChannelRunsForStop } from "../dist/channel-stop-fence.js";
import { integration, isolatedPostgres, seedMessageSpace } from "./postgres-database.fixture.mjs";

// The owning SQL boundary must distinguish positive non-delivery evidence from
// missing tracking, and serialize explicit choice against edits, stops and Jev.
// Existing first-message tests cannot exercise later/named/welcome publications.
integration("unaddressed publications require one current author choice and never infer delivery from missing evidence", async t => {
  const f = await isolatedPostgres("message_asks", { shard: true });
  const database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const placement = { spaceId: "space", shardId: "shard-0", placementEpoch: 1 };
  const asks = new PostgresMessageAskRepository(database, placement);
  const choices = new PostgresFirstMessageLaunchChoiceRepository(database, placement);
  const body = "Find why the login test flakes";
  const request = (id, extra = {}) => ({ requestId: crypto.randomUUID(), channelId: id, messageId: id,
    actorUserId: "owner", body, ...extra });
  const tx = callback => database.transaction({ requestId: crypto.randomUUID(), operation: "ask.test", placement }, callback);
  const read = id => tx(transaction => readMessageAsks(transaction, id, [id], "owner"));
  const observe = (id, extra = {}) => tx(transaction => recordMessageAskAtAppend(transaction, { spaceId: "space", ...request(id, extra) }));
  const pick = (id, harness = "codex", extra = {}) => asks.claim(request(id, { harness, ...extra }));
  const channel = async (id, { metadata = {}, sequence = 2, age = 0, text = body, author = "owner", kind = "xmatrix.message.text" } = {}) => {
    await f.run(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES($1,'space',$1,$1,'open',$1,1,$2::jsonb,now(),now())`, [id, JSON.stringify(metadata)]);
    await f.run(`INSERT INTO data.messages(space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
      message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence,body_hash)
      VALUES('space',$1,$1,$2,1,'user',$3,$4,'hash','inline','ref',now()-make_interval(secs => $5),now(),now(),$1,$6)`,
    [id, sequence, author, kind, age, await digestCanonicalCloneCborV1(text)]);
  };
  const authored = id => tx(transaction => messageAuthoredForActor(transaction, { spaceId: "space", channelId: id,
    messageId: `xmatrix-summon:${id}`, authorKind: "system", authorId: "xmatrix", actorUserId: "owner" }));
  try {
    await seedMessageSpace(f.client, { space: "space", channel: "seed", at: new Date().toISOString(), tables: [] });
    await f.run(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES('space','owner','owner',1,now(),now()),('space','other','member',1,now(),now())`);
    for (const harness of ["codex", "claude"]) {
      await f.run(`INSERT INTO data.agent_registrations(owner_user_id,machine_id,harness,version,created_at,updated_at)
        VALUES('owner','machine',$1,1,now(),now())`, [harness]);
      await f.run(`INSERT INTO data.space_agent_registrations(space_id,owner_user_id,machine_id,harness,display_name,configuration_json,version,created_at,updated_at)
        VALUES('space','owner','machine',$1,$1,'{}',1,now(),now())`, [harness]);
      await f.run(`INSERT INTO data.space_agent_registration_access(space_id,owner_user_id,machine_id,harness,
        grant_state,grant_revision,grant_limits,policy_state,policy_revision,policy_limits,updated_at)
        VALUES('space','owner','machine',$1,'active',1,'{}','enabled',1,'{}',now())`, [harness]);
    }
    await t.test("named, later and welcome messages get an explicit action; reload/connection alone chooses nothing", async () => {
      for (const [id, settings] of [["named", { sequence: 1 }], ["later", {}], ["welcome", { metadata: { welcome: true } }]]) {
        await channel(id, settings); await observe(id); await observe(id);
        assert.deepEqual(await read(id), [{ channelId: id, messageId: id, state: "unaddressed", canAsk: true }]);
        assert.equal((await f.run("SELECT count(*)::int AS n FROM data.first_message_launch_choices WHERE channel_id=$1", [id]))[0].n, 0);
      }
      const results = await Promise.allSettled([pick("named"), pick("named", "claude")]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const [choice] = await f.run("SELECT chosen_harness FROM data.first_message_launch_choices WHERE channel_id='named'");
      await pick("named", choice.chosen_harness); // lost HTTP acknowledgement replays the exact decision
      assert.equal((await read("named"))[0].canAsk, false);
      assert.equal(await authored("named"), true);
      await assert.rejects(pick("later", "codex", { actorUserId: "other" }), error => error.code === "message_ask_unavailable");
    });
    await t.test("untracked history, controls, platform cards and active first-message decisions are never called unaddressed", async () => {
      for (const [id, settings] of [["old", { age: 120 }], ["untracked", {}], ["control", { text: "/stop all" }],
        ["connector", { text: "@github:comment:LambdaLabsHQ/xmatrix#1 hello" }], ["card", { kind: "xmatrix.onboarding" }], ["first", { sequence: 1, metadata: { autoName: true } }]]) {
        await channel(id, settings);
        if (id !== "untracked") await observe(id, { body: settings.text ?? body });
        assert.ok((await read(id)).every(ask => !ask.canAsk));
      }
      await choices.open({ requestId: "open", channelId: "first", messageId: "first", authorUserId: "owner" });
      await observe("first"); assert.equal((await read("first"))[0].canAsk, false);
      await choices.claim({ ...request("first"), by: "author" });
      await observe("first"); assert.equal((await read("first"))[0].canAsk, false, "Don't start is never reopened");
      await assert.rejects(pick("untracked"), error => error.code === "message_ask_unavailable");
    });
    await t.test("uncertified pre-cutover observations stay unknown and cannot authorize a new choice", async () => {
      await channel("uncertified"); await observe("uncertified");
      await f.run("UPDATE data.message_asks SET commit_certified=NULL WHERE message_id='uncertified'");
      assert.deepEqual(await read("uncertified"), []);
      await assert.rejects(pick("uncertified"), error => error.code === "message_ask_unavailable");
    });
    await t.test("a delayed first-message reader and the explicit action share one atomic decision", async () => {
      await channel("race", { sequence: 1 }); await observe("race");
      await choices.open({ requestId: "late-open", channelId: "race", messageId: "race", authorUserId: "owner" });
      await f.run("UPDATE data.first_message_launch_choices SET deadline_at=now()-interval '1 second' WHERE channel_id='race'");
      const [author, jev] = await Promise.allSettled([pick("race"),
        choices.claim({ ...request("race"), by: "jev", harness: "claude" })]);
      const [decision] = await f.run("SELECT choice,chosen_harness,chosen_by FROM data.first_message_launch_choices WHERE channel_id='race'");
      assert.equal(decision.choice, "start");
      assert.equal(Number(author.status === "fulfilled") + Number(jev.status === "fulfilled" && jev.value.claimed), 1);
      assert.equal(decision.chosen_harness, decision.chosen_by === "author" ? "codex" : "claude");
    });
    await t.test("an attachment without a caption can be asked explicitly, while an empty publication has no action", async () => {
      for (const id of ["attachment", "empty"]) await channel(id, { text: "" });
      await f.run(`UPDATE data.messages SET attachments_json='[{"attachmentId":"photo"}]' WHERE message_id='attachment'`);
      await observe("attachment", { body: "" });
      await observe("empty", { body: "" });
      assert.equal((await read("attachment"))[0].canAsk, true);
      assert.deepEqual(await read("empty"), []);
      await pick("attachment", "codex", { body: "" });
      assert.equal(await authored("attachment"), true);
    });
    await t.test("a failed first-message reading can be chosen explicitly and remains recoverable even when sent long ago", async () => {
      await channel("failed", { sequence: 1, metadata: { autoName: true } });
      await choices.open({ requestId: "failed-open", channelId: "failed", messageId: "failed", authorUserId: "owner" });
      await choices.fail({ requestId: "failed-read", channelId: "failed", messageId: "failed", failureCode: "registration_not_found" });
      await observe("failed"); assert.equal((await read("failed"))[0].canAsk, true);
      await f.run("UPDATE data.first_message_launch_choices SET created_at=now()-interval '1 day' WHERE channel_id='failed'");
      await pick("failed");
      await f.run("UPDATE data.first_message_launch_choices SET chosen_at=now()-interval '30 seconds' WHERE channel_id='failed'");
      assert.deepEqual(await tx(transaction => readDueFirstMessageSummons(transaction, "failed")),
        [{ messageId: "failed", authorUserId: "owner", harness: "codex" }]);
    });
    await t.test("edits, recall, grant loss and stop fence the original publication before delayed admission", async () => {
      for (const [id, mutation] of [["edit", "edited_at=now(),invocation_input_version=2,entity_version=2"],
        ["recall", "recalled_at=now()"], ["delete", "deleted_at=now()"]]) {
        await channel(id); await observe(id); await pick(id); assert.equal(await authored(id), true);
        await f.run(`UPDATE data.messages SET ${mutation} WHERE message_id=$1`, [id]);
        assert.equal(await authored(id), false);
        await assert.rejects(pick(id), error => error.code === "message_ask_unavailable");
      }
      await channel("stopped"); await observe("stopped"); await pick("stopped");
      await tx(transaction => fenceChannelRunsForStop(transaction, { spaceId: "space", channelId: "stopped", actorUserId: "owner",
        sourceMessageId: "stop", at: new Date().toISOString(), scope: { kind: "channel" } }));
      assert.equal(await authored("stopped"), false, "stop cancels an allocated choice even before a Run exists");
      assert.deepEqual(await tx(transaction => readDueFirstMessageSummons(transaction, "stopped")), []);
      await channel("revoked"); await observe("revoked");
      await f.run("UPDATE data.space_members SET role='viewer' WHERE user_id='owner'");
      assert.equal((await read("revoked"))[0].canAsk, false);
      await assert.rejects(pick("revoked"), error => error.code === "channel_not_found");
      await f.run("UPDATE data.space_members SET role='owner' WHERE user_id='owner'");
    });
    await t.test("existing recipients and Automation occurrences keep their own delivery owner", async () => {
      await channel("sleeping");
      await f.run(`INSERT INTO data.instances(instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at,rest_state)
        VALUES('sleeping:1','sleeping:1#1','sleeping',1,'offline',1,now(),now(),'sleeping')`);
      await observe("sleeping"); assert.deepEqual(await read("sleeping"), []);
      await channel("scheduled", { sequence: 1 });
      await f.run(`INSERT INTO data.automation_occurrences(occurrence_id,automation_id,automation_version,owner_user_id,scheduled_for,status,
        attempts,next_attempt_at,run_id,instance_id,control_id,created_at,updated_at,message_id)
        VALUES('occurrence','task',1,'owner',now(),'pending',0,now(),'scheduled-run','scheduled-instance','scheduled-control',now(),now(),'scheduled')`);
      await observe("scheduled"); assert.deepEqual(await read("scheduled"), []);
      await assert.rejects(choices.open({ requestId: "automation-open", channelId: "scheduled", messageId: "scheduled", authorUserId: "owner" }),
        error => error.code === "launch_choice_unavailable");
    });
  } finally { await f.close(); }
});
