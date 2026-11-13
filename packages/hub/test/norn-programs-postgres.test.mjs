import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createAuthorityDatabase, PostgresNornProgramRepository, readWaitingNornPrograms, NORN_CHANNEL_DUE_SQL } from "../../db/dist/index.js";
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

/** One conversation of an owned Space in its own database, with the repository over it. */
async function conversation(prefix, body) {
  const f = await isolatedPostgres(prefix);
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
    database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0",
      clientFactory: config => new Client({ ...config, options: `-c role=${f.role}` }), statementTimeoutMs: 5000,
      transactionTimeoutMs: 10000, lockTimeoutMs: 2000 }).openSession();
    const programs = new PostgresNornProgramRepository(database, placement);
    const scope = (programId = "program") => ({ requestId: randomUUID(), channelId: "channel", programId });
    /** A turn of an Instance on a message, as the daemon's execution report records it. */
    const execution = (binding, instance, messageId, state, at = 1) => sql(`INSERT INTO data.agent_message_executions(binding_id,space_id,
      channel_id,run_id,instance_id,agent_name,channel_instance_id,execution_id,revision,binding_digest,report_digest,source_message_id,
      source_entity_version,source_body_hash,source_sequence,source_count,state,started_at_millis,updated_at_millis,finished_at_millis,
      created_at,observed_at,expires_at)
      VALUES ($1,'space','channel',$2,$3,'codex',split_part($3,':',2),$1,1,repeat('b',64),repeat('c',64),$4,1,repeat('a',64),1,1,$5,
        $6,$6,CASE WHEN $5 IN ('accepted','running') THEN NULL ELSE $6::bigint END,now(),now(),now()+interval '1 day')`,
    [binding, `${instance}#1`, instance, messageId, state, at]);
    /** An Instance in the conversation with its live Run. */
    const instance = async id => {
      await sql(`INSERT INTO data.runs(run_id,owner_user_id,channel_id,status,version,created_at,updated_at)
        VALUES ($1,'owner','channel','running',1,now(),now()) ON CONFLICT (run_id) DO NOTHING`, [`${id}#1`]);
      await sql(`INSERT INTO data.instances(instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
        VALUES ($1,$2,'channel',split_part($1,':',2)::int,'idle',1,now(),now())`, [id, `${id}#1`]);
    };
    const due = async () => (await sql(`SELECT ${NORN_CHANNEL_DUE_SQL} <= clock_timestamp() AS due`, ["channel"]))[0].due;
    const inTransaction = work => database.transaction({ requestId: randomUUID(), operation: "norn.test", placement }, work);
    await body({ sql, message, programs, scope, execution, instance, due, inTransaction, database });
  } finally {
    await database?.close?.();
    await f.close();
  }
}

integration("a program's ledger, its delivery and its holder live in PostgreSQL, and an abandoned request is never silent", () =>
  conversation("norn_programs", async ({ sql, message, programs, scope, execution, instance, due, inTransaction, database }) => {
    await message("program", 1, "user", "owner");
    const start = (programId = "program") => programs.start({ ...scope(programId), authorKind: "user", authorId: "owner",
      authorityUserId: "owner", source, ledger: nornStartLedger }, nornStep());

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
    await execution("binding", "channel:2", delivery.deliveryMessageId, "running");
    await programs.delivered({ ...scope(), ledgerRequestId: delivery.requestId, epoch: 0 });
    work = await programs.channelWork(scope());
    assert.deepEqual([work.passes, work.deliveries], [[], []]);
    assert.equal(await due(), null);
    const held = run => programs.heldRequest({ requestId: randomUUID(), channelId: "channel", requestRef: delivery.requestRef, runId: run });
    assert.equal((await held("channel:2#1")).requestId, delivery.requestId);
    await assert.rejects(held("channel:3#1"), { code: "norn_request_not_held" });
    const open = await programs.openRequests({ requestId: randomUUID(), channelId: "channel", runId: "channel:2#1", instanceId: "channel:2" });
    assert.deepEqual(open.map(row => [row.requestRef, row.held, row.asked, row.text]), [[delivery.requestRef, true, false, "Review the design"]]);

    // A newer message interrupts the turn: the work is not over while its Instance is there to go on with it.
    await instance("channel:2");
    await sql("UPDATE data.agent_message_executions SET state='interrupted',revision=2,updated_at_millis=2,finished_at_millis=2");
    assert.equal(await due(), null);
    assert.deepEqual((await programs.channelWork(scope())).passes, []);
    // Once that Instance has ended a later turn without answering, the request is left behind.
    await execution("later", "channel:2", "program", "completed", 3);
    assert.equal(await due(), true);
    // The turn ends with no answer: the request is abandoned, its program is due, and the pass ends it Broke.
    await sql("UPDATE data.agent_message_executions SET state='completed',revision=3 WHERE binding_id='binding'");
    assert.equal(await due(), true);
    assert.deepEqual((await programs.channelWork(scope())).passes, ["program"]);
    assert.equal((await programs.advance(scope(), nornStep())).status, "completed");
    await assert.rejects(held("channel:2#1"), { code: "norn_request_ended" });
    work = await programs.channelWork(scope());
    assert.deepEqual([work.passes, work.deliveries, work.reports.map(report => [report.state, report.authorMention, report.ended.result.value])],
      [[], [], [["completed", null, "The Agent's work on this request ended without an answer"]]]);
    await programs.reported(scope());
    // The request has ended: what its delivery started is let go, once. Nothing was launched here, so there is nothing to stop.
    assert.equal(await due(), true);
    assert.deepEqual((await programs.channelWork(scope())).releases.map(release => [release.requestId, release.runId, release.mention, release.authorityUserId]),
      [[delivery.requestId, null, null, "owner"]]);
    await programs.released({ ...scope(), ledgerRequestId: delivery.requestId });
    assert.deepEqual((await programs.channelWork(scope())).releases, []);
    assert.equal(await due(), null);

    // A program that waits for an outside event is found by what it waits on, and hears the event in its ledger.
    await message("events", 4, "user", "owner");
    await programs.start({ ...scope("events"), authorKind: "user", authorId: "owner", authorityUserId: "owner",
      source: `ciFailed("acme/app")->forEach(what => ask(@codex, what)->wait)`, ledger: nornStartLedger }, nornStep());
    const [waiting] = await readWaitingNornPrograms(database, { requestId: randomUUID(), spaceId: "space" });
    assert.deepEqual([waiting.programId, waiting.authorityUserId, waiting.waits.map(stream => stream.name)], ["events", "owner", ["ciFailed"]]);
    await programs.advance(scope("events"), nornStep(undefined, { stream: waiting.waits[0], what: "Workflow CI failed on main" }));
    assert.deepEqual((await programs.channelWork(scope())).deliveries.map(each => [each.programId, each.request.text]),
      [["events", "Workflow CI failed on main"]]);
    // While its round runs it still listens: an event then is kept for the loop, not lost.
    assert.deepEqual((await readWaitingNornPrograms(database, { requestId: randomUUID(), spaceId: "space" })).map(program => program.programId), ["events"]);
    await programs.advance(scope("events"), nornStep({ requestId: (await programs.channelWork(scope())).deliveries[0].requestId, epoch: 0,
      reply: { tag: "Refused", reason: "not now" } }));
    // The round over, it goes on listening; removed, it is gone from every later pass.
    assert.equal((await readWaitingNornPrograms(database, { requestId: randomUUID(), spaceId: "space" })).length, 1);
    await programs.remove(scope("events"));
    assert.equal((await programs.advance(scope("events"), nornStep())).status, "failed");
    await programs.reported(scope("events"));
    // A request of a person needs nothing working on it: it stays theirs while they can read the conversation,
    // is found by their id alone, and ends when they no longer can.
    await message("person", 5, "user", "owner");
    await sql(`INSERT INTO control.auth_users (id,name,email,handle,profile_version,created_at,updated_at)
      VALUES ('owner','Owner','owner@example.com','owner',1,now(),now()) ON CONFLICT (id) DO NOTHING`);
    await programs.start({ ...scope("person"), authorKind: "user", authorId: "owner", authorityUserId: "owner",
      source: `switch ask(@Owner, "Approve the budget?")->wait { | Broke(why) => why | other => fail(other) }`, ledger: nornStartLedger }, nornStep());
    const [asked] = (await programs.channelWork(scope())).deliveries;
    assert.deepEqual(await programs.people({ requestId: randomUUID(), channelId: "channel", matches: name => name === "Owner" }), ["owner"]);
    await programs.delivered({ ...scope("person"), ledgerRequestId: asked.requestId, epoch: asked.epoch, holderUserId: "owner" });
    assert.deepEqual((await programs.channelWork(scope())).passes, []);
    assert.equal((await programs.personRequest({ requestId: randomUUID(), requestRef: asked.requestRef, userId: "owner" })).programId, "person");
    assert.equal(await programs.personRequest({ requestId: randomUUID(), requestRef: asked.requestRef, userId: "someone-else" }), undefined);
    // The conversation is closed to them: the request is left with nobody, and the next pass ends it with the reason.
    await sql("UPDATE data.channels SET mode='closed' WHERE channel_id='channel'");
    await sql("UPDATE data.space_members SET role='member' WHERE space_id='space' AND user_id='owner'");
    assert.deepEqual((await programs.channelWork(scope())).passes, ["person"]);
    assert.equal((await programs.advance(scope("person"), nornStep())).status, "completed");
    await sql("UPDATE data.channels SET mode='open' WHERE channel_id='channel'");
    await sql("UPDATE data.space_members SET role='owner' WHERE space_id='space' AND user_id='owner'");
    assert.match((await sql("SELECT ledger_json->'ended'->'result'->>'value' AS why FROM data.norn_programs WHERE program_id='person'"))[0].why,
      /@Owner can no longer read this conversation/u);
    // Ended, its card is still to be told how; told, nothing is left of it.
    const [closing] = (await programs.channelWork(scope())).closings;
    assert.deepEqual([closing.programId, closing.holderUserId, closing.deliveryMessageId], ["person", "owner", asked.deliveryMessageId]);
    await programs.released({ ...scope("person"), ledgerRequestId: asked.requestId });
    assert.deepEqual((await programs.channelWork(scope())).closings, []);
    await programs.reported(scope("person"));
    // A pass that cannot be made here moves only the time of the next one: the program and its ledger stay as they are.
    await message("skewed", 6, "user", "owner");
    await programs.start({ ...scope("skewed"), authorKind: "user", authorId: "owner", authorityUserId: "owner",
      source: `after(1h)->wait`, ledger: nornStartLedger }, nornStep());
    const before = (await sql("SELECT ledger_json,revision FROM data.norn_programs WHERE program_id='skewed'"))[0];
    const retryAt = Date.now() + 5 * 60_000;
    await programs.advance(scope("skewed"), () => ({ write: { retryAtMs: retryAt }, result: undefined }));
    const [kept] = await sql("SELECT ledger_json,revision,state,next_due_at FROM data.norn_programs WHERE program_id='skewed'");
    assert.deepEqual([kept.ledger_json, kept.revision, kept.state, kept.next_due_at.getTime()], [before.ledger_json, before.revision, "running", retryAt]);
    await programs.remove(scope("skewed"));
    await programs.advance(scope("skewed"), nornStep());
    await programs.reported(scope("skewed"));
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
  }));

integration("work that broke off is handed on once, and in a Page program's conversation the Agent that worked last stays", () =>
  conversation("norn_page_stays", async ({ sql, message, programs, scope, execution, instance, due }) => {
    await message("page-program", 1, "system", "xmatrix");
    await programs.start({ ...scope("page-program"), authorKind: "user", authorId: "owner", authorityUserId: "owner",
      page: { pageId: "page", name: "main" }, ledger: nornStartLedger,
      source: `run(@codex, "First")->wait?\nrun(@claude, "Second")->wait` }, nornStep());
    const work = () => programs.channelWork(scope());
    const deliver = async (to, programId = "page-program") => {
      const [delivery] = (await work()).deliveries.filter(each => each.programId === programId);
      await instance(to);
      await programs.delivered({ ...scope(programId), ledgerRequestId: delivery.requestId, epoch: delivery.epoch, instanceId: to });
      return delivery;
    };
    const answer = (delivery, programId = "page-program") => programs.advance(scope(programId),
      nornStep({ requestId: delivery.requestId, epoch: delivery.epoch, reply: { typed: "done" } }));
    const ended = id => sql("UPDATE data.runs SET status='stopped' WHERE run_id=$1", [`${id}#1`]);

    // The first Agent's turn fails: no answer, and nothing works on the request any more.
    const first = await deliver("channel:5");
    assert.equal(first.handedOn, false);
    await execution("failed-turn", "channel:5", first.deliveryMessageId, "failed");
    await ended("channel:5");
    assert.deepEqual((await work()).passes, ["page-program"]);
    // The program is not told yet: the same request is held anew, and delivered again as another message.
    assert.equal((await programs.advance(scope("page-program"), nornStep())).status, "running");
    const again = await deliver("channel:6");
    assert.deepEqual([again.requestId, again.epoch, again.deliveryMessageId, again.handedOn],
      [first.requestId, first.epoch + 1, `norn:${first.requestRef}:${first.epoch + 1}`, true]);
    await answer(again);
    // While the program runs, whoever answered it stays for its next request.
    assert.deepEqual((await work()).releases, []);
    const second = await deliver("channel:7");
    assert.equal((await answer(second)).status, "completed");
    await programs.reported(scope("page-program"));
    // The program over, the Agent that worked last stays where a person can reach it; the one before is let go.
    assert.deepEqual((await work()).releases.map(release => release.requestId), [first.requestId]);
    await programs.released({ ...scope("page-program"), ledgerRequestId: first.requestId });
    assert.deepEqual([(await work()).releases, await due()], [[], null]);

    // An Agent that asked a question while it held a request stays until the question is answered, though its request has ended.
    await message("in-message", 2, "user", "owner");
    await programs.start({ ...scope("in-message"), authorKind: "user", authorId: "owner", authorityUserId: "owner", ledger: nornStartLedger,
      source: `run(@codex, "Third")->wait` }, nornStep());
    const third = await deliver("channel:8", "in-message");
    await message("question", 3, "system", "xmatrix");
    await programs.start({ ...scope("question"), authorKind: "agent", authorId: "channel:8", authorityUserId: "owner", ledger: nornStartLedger,
      source: `ask(@claude, "Which bucket?")->wait` }, nornStep());
    assert.equal((await answer(third, "in-message")).status, "completed");
    await programs.reported(scope("in-message"));
    assert.deepEqual((await work()).releases, []);
    const [question] = (await work()).deliveries;
    await programs.advance(scope("question"), nornStep({ requestId: question.requestId, epoch: question.epoch, reply: { tag: "Refused", reason: "no" } }));
    assert.deepEqual((await work()).releases.map(release => release.requestId), [third.requestId]);
  }));
