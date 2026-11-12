import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createAuthorityDatabase, PostgresNornProgramRepository, NORN_CHANNEL_DUE_SQL } from "../../db/dist/index.js";
import { fenceChannelRunsForStop } from "../../db/dist/channel-stop-fence.js";
import { initialMessageSource } from "../../db/dist/runtime-initial-input.js";
import { integration, isolatedPostgres, seedOwnedTestSpace } from "../../db/test/postgres-database.fixture.mjs";
import { nornStartLedger, nornStep } from "../src/norn-host.ts";

const placement = { spaceId: "space", shardId: "shard-0", placementEpoch: 1 };
const source = `switch run(@codex, "Review the design")->wait {
| Answered(_) => "reviewed"
| Broke(why) => why
| other => fail(other)
}`;

integration("a program's ledger, its delivery and its holder live in PostgreSQL, and an abandoned request is never silent", async () => {
  const f = await isolatedPostgres("norn_programs");
  const sql = async (text, values = []) => (await f.client.query(text, values)).rows;
  let database;
  try {
    await seedOwnedTestSpace(f.client, "space", "owner");
    await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES ('channel','space','Conversation','channel','open','channel',1,now(),now())`);
    const message = (id, sequence, kind, author) => sql(`INSERT INTO data.messages(space_id,channel_id,message_id,timeline_sequence,
      entity_version,author_kind,author_id,message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
      body_hash,created_at) VALUES ('space','channel',$1,$2,1,$3,$4,'xmatrix.message.text',repeat('a',64),'inline','fixture',
        now(),now(),$1,repeat('a',64),now())`, [id, sequence, kind, author]);
    await message("program", 1, "user", "owner");
    database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0",
      clientFactory: config => new Client({ ...config, options: `-c role=${f.role}` }), statementTimeoutMs: 5000,
      transactionTimeoutMs: 10000, lockTimeoutMs: 2000 }).openSession();
    const programs = new PostgresNornProgramRepository(database, placement);
    const scope = (programId = "program") => ({ requestId: randomUUID(), channelId: "channel", programId });
    const start = (programId = "program") => programs.start({ ...scope(programId), authorKind: "user", authorId: "owner",
      authorityUserId: "owner", source, ledger: nornStartLedger }, nornStep());
    const due = async () => (await sql(`SELECT ${NORN_CHANNEL_DUE_SQL} <= clock_timestamp() AS due`, ["channel"]))[0].due;
    const inTransaction = body => database.transaction({ requestId: randomUUID(), operation: "norn.test", placement }, body);

    // The message is the program: it starts once, and a message that is not there starts nothing.
    assert.equal((await start()).status, "running");
    assert.equal(await start(), undefined);
    assert.equal(await start("absent"), undefined);
    let work = await programs.channelWork(scope());
    assert.deepEqual([work.passes, work.reports], [[], []]);
    const [delivery] = work.deliveries;
    assert.deepEqual([delivery.holder, delivery.epoch, delivery.request.text], ["@codex", 0, "Review the design"]);
    assert.equal(delivery.deliveryMessageId, `norn:${delivery.requestRef}:0`);
    assert.equal(await due(), true);

    // xMatrix's delivery message may start a Run for the program's authority, and for nobody else.
    await message(delivery.deliveryMessageId, 2, "system", "xmatrix");
    const sourceFor = actorUserId => inTransaction(tx => initialMessageSource(tx, { spaceId: "space", channelId: "channel",
      messageId: delivery.deliveryMessageId, actorUserId }));
    assert.equal((await sourceFor("owner")).messageId, delivery.deliveryMessageId);
    assert.equal(await sourceFor("someone-else"), undefined);

    // While a turn works on the delivery the request is held; only that Run answers it.
    await sql(`INSERT INTO data.runs(run_id,owner_user_id,channel_id,status,version,created_at,updated_at)
      VALUES ('channel:2#1','owner','channel','running',1,now(),now()),('channel:3#1','owner','channel','running',1,now(),now())`);
    await sql(`INSERT INTO data.agent_message_executions(binding_id,space_id,channel_id,run_id,instance_id,agent_name,
      channel_instance_id,execution_id,revision,binding_digest,report_digest,source_message_id,source_entity_version,
      source_body_hash,source_sequence,source_count,state,started_at_millis,updated_at_millis,created_at,observed_at,expires_at)
      VALUES ('binding','space','channel','channel:2#1','channel:2','codex','2','execution',1,repeat('b',64),repeat('c',64),$1,1,
        repeat('a',64),2,1,'running',1,1,now(),now(),now()+interval '1 day')`, [delivery.deliveryMessageId]);
    await programs.delivered({ ...scope(), ledgerRequestId: delivery.requestId, epoch: 0 });
    work = await programs.channelWork(scope());
    assert.deepEqual([work.passes, work.deliveries], [[], []]);
    assert.equal(await due(), null);
    const held = run => programs.heldRequest({ requestId: randomUUID(), channelId: "channel", requestRef: delivery.requestRef, runId: run });
    assert.equal((await held("channel:2#1")).requestId, delivery.requestId);
    await assert.rejects(held("channel:3#1"), { code: "norn_request_not_held" });
    const open = await programs.openRequests({ requestId: randomUUID(), channelId: "channel", runId: "channel:2#1", instanceId: "channel:2" });
    assert.deepEqual(open.map(row => [row.requestRef, row.held, row.asked, row.text]), [[delivery.requestRef, true, false, "Review the design"]]);

    // The turn ends with no answer: the request is abandoned, its program is due, and the pass ends it Broke.
    await sql("UPDATE data.agent_message_executions SET state='completed',revision=2,updated_at_millis=2,finished_at_millis=2");
    assert.equal(await due(), true);
    assert.deepEqual((await programs.channelWork(scope())).passes, ["program"]);
    assert.equal((await programs.advance(scope(), nornStep())).status, "completed");
    await assert.rejects(held("channel:2#1"), { code: "norn_request_ended" });
    work = await programs.channelWork(scope());
    assert.deepEqual([work.passes, work.deliveries, work.reports.map(report => [report.state, report.authorMention, report.ended.result.value])],
      [[], [], [["completed", null, "The Agent's work on this request ended without an answer"]]]);
    await programs.reported(scope());
    // The request has ended while the Run it started is still live: that Run is let go, once.
    assert.equal(await due(), true);
    await sql(`INSERT INTO data.agent_launches(launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,run_id,instance_id,
      execution_key,control_id,machine_id,state,spawn_payload_json,next_attempt_at,created_at,updated_at)
      VALUES ('launch','space','channel',$1,'registration','owner','channel:2#1','channel:2','key','control','machine','connected',
        '{}',now(),now(),now())`, [delivery.deliveryMessageId]);
    assert.deepEqual((await programs.channelWork(scope())).releases.map(release => [release.requestId, release.runId, release.authorityUserId]),
      [[delivery.requestId, "channel:2#1", "owner"]]);
    await programs.released({ ...scope(), ledgerRequestId: delivery.requestId });
    assert.deepEqual((await programs.channelWork(scope())).releases, []);
    assert.equal(await due(), null);

    // A stop of the Channel ends its running programs at their next pass; a stop of one Run does not.
    await message("second", 3, "user", "owner");
    await start("second");
    const stop = scopeOfStop => inTransaction(tx => fenceChannelRunsForStop(tx, { spaceId: "space", channelId: "channel",
      actorUserId: "owner", sourceMessageId: "stop", at: new Date().toISOString(), scope: scopeOfStop }));
    await stop({ kind: "run", runId: "channel:3#1" });
    assert.deepEqual((await programs.channelWork(scope())).passes, []);
    await stop({ kind: "channel" });
    assert.deepEqual((await programs.channelWork(scope())).passes, ["second"]);
    assert.equal((await programs.advance(scope("second"), nornStep())).status, "failed");
    const [ended] = (await programs.channelWork(scope())).reports;
    assert.deepEqual([ended.programId, ended.ended.error], ["second", "Stopped in the conversation"]);
    assert.deepEqual(await sql("SELECT count(*)::int AS open FROM data.norn_requests WHERE settled_at IS NULL"), [{ open: 0 }]);
  } finally {
    await database?.close?.();
    await f.close();
  }
});
