import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { createAuthorityDatabase, DatabasePlacementStaleError, PostgresNornShadowRepository } from "../../db/dist/index.js";
import { integration,isolatedPostgres,seedOwnedTestSpace } from "../../db/test/postgres-database.fixture.mjs";
import { nornShadowEvaluator } from "../src/norn-shadow-evaluator.ts";
import { runLifecycleMaintenance } from "../../db/scripts/postgres-lifecycle-maintenance.mjs";
import { openNornComparison,sealNornComparison } from "../../db/dist/secret-value-control.js";

const { programs } = JSON.parse(readFileSync(new URL("./fixtures/norn-shadow-programs.json",import.meta.url),"utf8"));
const placement = { spaceId: "space",shardId: "shard-0",placementEpoch: 1 };
const key = "fixture-only-norn-comparison-key";
integration("a fenced PG comparison restores, observes exact receipts and never writes legacy work",async t => {
  const f = await isolatedPostgres("norn_shadow");
  const sql = (text,values = []) => f.client.query(text,values);
  let database;
  try {
    await seedOwnedTestSpace(f.client,"space","owner");
    await sql(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES ('channel','space','Conversation','channel','open','channel',1,now(),now())`);
    await sql(`INSERT INTO data.runs(run_id,owner_user_id,channel_id,status,version,created_at,updated_at)
      VALUES ('channel:2#1','owner','channel','running',1,now(),now())`);
    await sql(`INSERT INTO data.messages(space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
      message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,body_hash,created_at)
      VALUES ('space','channel','source',1,1,'user','owner','xmatrix.message.text',repeat('a',64),'inline','fixture',
        now(),now(),'source',repeat('a',64),now())`);
    await sql(`INSERT INTO data.agent_message_executions(binding_id,space_id,channel_id,run_id,instance_id,agent_name,
      channel_instance_id,execution_id,revision,binding_digest,report_digest,source_message_id,source_entity_version,
      source_body_hash,source_sequence,source_count,state,started_at_millis,updated_at_millis,created_at,observed_at,expires_at)
      VALUES ('binding','space','channel','channel:2#1','channel:2','codex','2','execution',1,repeat('b',64),repeat('c',64),'source',1,
        repeat('a',64),1,1,'running',1,1,now(),now(),now()+interval '1 day')`);
    // PostgreSQL itself denies any legacy mutation by the comparison worker.
    await sql(`REVOKE INSERT,DELETE ON data.messages,data.runs,data.agent_message_executions,data.message_attention,
      data.automations,data.automation_occurrences,data.outbox FROM ${f.role}`);
    // FOR SHARE requires UPDATE privilege, though it changes no row. A
    // statement trigger independently refuses actual writes by this role.
    await sql(`CREATE FUNCTION data.norn_deny_legacy_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_user='${f.role}' THEN RAISE EXCEPTION 'observer attempted a legacy write'; END IF; RETURN NULL; END $$`);
    for (const table of ["messages","runs","agent_message_executions","message_attention","automations","automation_occurrences","outbox"]) {
      await sql(`CREATE TRIGGER norn_deny_legacy_write BEFORE UPDATE ON data.${table}
        FOR EACH STATEMENT EXECUTE FUNCTION data.norn_deny_legacy_write()`);
    }
    database = createAuthorityDatabase({ connectionString: f.url.toString(),shardId: "shard-0",
      clientFactory: config => new Client({ ...config,options: `-c role=${f.role}` }),statementTimeoutMs: 5000,
      transactionTimeoutMs: 10000,lockTimeoutMs: 2000 }).openSession();
    const repo = (connection=database) => new PostgresNornShadowRepository(connection,placement,key,nornShadowEvaluator);
    const request = () => ({ requestId: randomUUID(),actorUserId: "owner",channelId: "channel",comparisonId: randomUUID() });
    const admit = async (name="run") => {
      const input = { ...request(),ast: programs[name].ast,sourceBindingId: "binding",participant: "@codex:2" };
      const state = await repo().admit(input);
      return { input,state };
    };
    const step = (input,revision) => repo().step({ ...input,requestId: randomUUID(),expectedRevision: revision });
    const finish = async () => {
      await sql(`UPDATE data.agent_message_executions SET state='completed',revision=2,
        updated_at_millis=2,finished_at_millis=2 WHERE binding_id='binding'`);
      await sql(`INSERT INTO data.messages(space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
        message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,body_hash,agent_final_reply_json,created_at)
        VALUES ('space','channel','final',2,1,'agent','channel:2','xmatrix.message.text',repeat('d',64),'inline','private-reply',
          now(),now(),'final',repeat('d',64),jsonb_build_object('runId','channel:2#1','executionId','execution','instanceId','channel:2','bodyHash',repeat('d',64)),now())
        ON CONFLICT (space_id,message_id) DO UPDATE SET recalled_at=NULL`);
    };
    await t.test("admitted trials have no count, checkpoint-size or fixed-day quota",async () => {
      for (let i=0;i<33;i++) {
        const { input } = await admit();
        await repo().revoke({ ...input,expectedRevision: 0 });
      }
      const large = JSON.parse(programs.run.ast);
      large.program.body[0].args[1].value = "x".repeat(300_000);
      const input = { ...request(),ast: JSON.stringify(large),sourceBindingId: "binding",participant: "@codex:2" };
      await repo().admit(input);
      const proposed = await step(input,0);
      assert.equal(proposed.state,"waiting");
      await repo().revoke({ ...input,expectedRevision: proposed.revision });
      const long = JSON.parse(programs.timerDeadline.ast);
      long.program.body[0].args[0].args[0].amount = "7";
      long.program.body[0].args[0].args[0].unit = "d";
      long.program.body[0].args[1].value.amount = "8";
      long.program.body[0].args[1].value.unit = "d";
      const waiting = { ...request(),ast: JSON.stringify(long),sourceBindingId: "binding",participant: "@codex:2" };
      await repo().admit(waiting);
      await sql("UPDATE data.norn_shadow_comparisons SET created_at=now()-interval '2 days' WHERE comparison_id=$1",[waiting.comparisonId]);
      const state = await step(waiting,0);
      assert.equal(state.state,"waiting");
      assert.ok(Date.parse(state.nextDueAt) > Date.now()+6*86400000);
      assert.ok((await sql("SELECT encrypted_value_json FROM data.norn_shadow_comparisons WHERE comparison_id=$1",[waiting.comparisonId])).rows[0].encrypted_value_json);
    });
    await t.test("long journals resume and reports page through every retained transition",async () => {
      const { input } = await admit(); await step(input,0);
      const [row] = (await sql("SELECT * FROM data.norn_shadow_comparisons WHERE comparison_id=$1",[input.comparisonId])).rows;
      const checkpoint = await openNornComparison(key,row);
      const encrypted = await sealNornComparison(key,"space",input.comparisonId,1002,checkpoint);
      // Historical metadata and its authenticated checkpoint, as after a restart.
      await sql(`INSERT INTO data.norn_shadow_transitions (space_id,comparison_id,channel_id,revision,kind,classification,reason)
        SELECT 'space',$1,'channel',n,'yield','incomplete','computation_slice' FROM generate_series(2,1002) n`,[input.comparisonId]);
      await sql("UPDATE data.norn_shadow_comparisons SET revision=1002,encrypted_value_json=$2::jsonb WHERE comparison_id=$1",[input.comparisonId,JSON.stringify(encrypted)]);
      assert.equal((await step(input,1002)).state,"waiting");
      const page = await repo().report(input);
      assert.equal(page.transitions.length,1000);
      assert.equal(page.nextAfterRevision,1000);
      const rest = await repo().report({ ...input,afterRevision: page.nextAfterRevision });
      assert.deepEqual(rest.transitions.map(item => Number(item.revision)),[1001,1002]);
      assert.equal(rest.nextAfterRevision,null);
    });
    await t.test("admission is idempotent, version-pinned and scoped",async () => {
      const { input,state } = await admit();
      assert.deepEqual(await repo().admit(input),state);
      await assert.rejects(repo().admit({ ...input,ast: programs.message.ast }),{ code: "norn_admission_exists" });
      await assert.rejects(repo().admit({ ...input,comparisonId: randomUUID(),actorUserId: "outsider" }),{ code: "norn_comparison_unavailable" });
      await assert.rejects(repo().admit({ ...input,comparisonId: randomUUID(),participant: "@other" }),{ code: "norn_source_participant_mismatch" });
      await assert.rejects(repo().admit({ ...input,comparisonId: input.comparisonId+" " }),{ code: "invalid_norn_comparison" });
      const waiting = await step(input,0);
      assert.equal(waiting.state,"waiting");
      await sql("UPDATE data.runs SET status='completed' WHERE run_id='channel:2#1'");
      assert.equal((await step(input,waiting.revision)).revision,waiting.revision,"process exit cannot synthesize an answer");
      await finish();
      const other = database.openSession();
      let concurrent;
      try {
        concurrent = await Promise.allSettled([step(input,waiting.revision),repo(other).step({ ...input,
          requestId: randomUUID(),expectedRevision: waiting.revision })]);
      } finally { await other.close(); }
      assert.equal(concurrent.filter(item => item.status === "fulfilled").length,1);
      assert.equal(concurrent.find(item => item.status === "rejected").reason.code,"norn_checkpoint_conflict");
      const woke = concurrent.find(item => item.status === "fulfilled").value;
      assert.equal(woke.state,"completed","the source's final observation includes its pure continuation before clearing private state");
      assert.equal((await step(input,woke.revision)).revision,woke.revision);
      const report = await repo().report(input);
      assert.equal(report.transitions.filter(item => item.reason === "exact_final_receipt").length,1);
      assert.equal(report.transitions.at(-1).outcome_tag,"Done");
      assert.equal((await sql("SELECT disposition FROM data.norn_shadow_observations WHERE comparison_id=$1 AND disposition='consumed'",[input.comparisonId])).rowCount,1);
    });
    await t.test("preexisting receipts are facts; proposed messages grant no action capability",async () => {
      const before = (await sql("SELECT count(*)::int n FROM data.messages")).rows[0].n;
      const { input } = await admit("message");
      let result = await step(input,0);
      for (let i=0;i<6 && result.state !== "completed";i++) result = await step(input,result.revision);
      assert.equal(result.state,"incomplete","an already ended source cannot keep private state for a later request");
      const report = await repo().report(input);
      assert.ok(report.transitions.some(item => item.reason === "message_proposed"));
      assert.match(report.transitions.find(item => item.operation === "say").intent_digest,/^[0-9a-f]{64}$/u);
      assert.equal(report.transitions.at(-1).classification,"incomplete","unmapped effects prevent an equivalence claim");
      assert.equal((await sql("SELECT count(*)::int n FROM data.messages")).rows[0].n,before);
      assert.equal((await sql("SELECT count(*)::int n FROM data.outbox")).rows[0].n,0);
      assert.equal(JSON.stringify((await sql("SELECT * FROM data.norn_shadow_comparisons")).rows).includes("private proposed text"),false);
      assert.equal(JSON.stringify(report).includes("private proposed text"),false);
    });
    await t.test("a write failure rolls back both inbox and checkpoint",async () => {
      const { input } = await admit();
      await sql(`CREATE FUNCTION data.norn_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'injected checkpoint failure' USING ERRCODE='40001'; END $$`);
      await sql("CREATE TRIGGER norn_test_failure BEFORE UPDATE ON data.norn_shadow_comparisons FOR EACH ROW EXECUTE FUNCTION data.norn_test_fail()");
      await assert.rejects(step(input,0));
      await sql("DROP TRIGGER norn_test_failure ON data.norn_shadow_comparisons");
      assert.equal((await sql("SELECT revision FROM data.norn_shadow_comparisons WHERE comparison_id=$1",[input.comparisonId])).rows[0].revision,"0");
      assert.equal((await sql("SELECT 1 FROM data.norn_shadow_observations WHERE comparison_id=$1",[input.comparisonId])).rowCount,0);
      assert.equal((await step(input,0)).state,"completed");
    });
    await t.test("late receipts remain evidence without changing the committed timeout",async () => {
      await sql("UPDATE data.messages SET recalled_at=now() WHERE message_id='final'");
      const { input } = await admit("past");
      const failed = await step(input,0);
      assert.equal(failed.state,"failed");
      assert.ok((await repo().report(input)).transitions.some(item => item.reason === "exclusive_deadline"));
      await finish();
      assert.equal((await step(input,failed.revision)).revision,failed.revision);
      assert.equal((await sql("SELECT 1 FROM data.norn_shadow_observations WHERE comparison_id=$1 AND disposition='late'",[input.comparisonId])).rowCount,1);
    });
    await t.test("ciphertext, old ABI and revoked sources fail closed",async () => {
      const a = await admit(),b = await admit();
      await sql(`UPDATE data.norn_shadow_comparisons SET encrypted_value_json=(SELECT encrypted_value_json
        FROM data.norn_shadow_comparisons WHERE comparison_id=$2) WHERE comparison_id=$1`,[a.input.comparisonId,b.input.comparisonId]);
      await assert.rejects(step(a.input,0),{ code: "secret_authority_corrupt" });
      await sql("UPDATE data.norn_shadow_comparisons SET machine_abi='unknown' WHERE comparison_id=$1",[b.input.comparisonId]);
      assert.equal((await step(b.input,0)).reason,"unsupported_version");
      const c = await admit();
      await sql("UPDATE data.messages SET recalled_at=now() WHERE message_id='source'");
      assert.equal((await step(c.input,0)).reason,"source_unavailable");
      await sql("UPDATE data.messages SET recalled_at=NULL WHERE message_id='source'");
      const d = await admit();
      await sql("UPDATE data.space_members SET role='member',version=version+1 WHERE user_id='owner'");
      assert.equal((await step(d.input,0)).state,"revoked");
      assert.equal((await sql("SELECT encrypted_value_json FROM data.norn_shadow_comparisons WHERE comparison_id=$1",[d.input.comparisonId])).rows[0].encrypted_value_json,null);
      await sql("UPDATE data.space_members SET role='owner',version=version+1 WHERE user_id='owner'");
    });
    await t.test("source end clears private state; source evidence removal cascades only comparison records",async () => {
      const { input } = await admit();
      const maintenance = await runLifecycleMaintenance(f.client,{ dryRun: false,batchSize: 1000,maxRows: 1000,budgetMs: 30000 });
      assert.ok(maintenance.maintainedNornComparisons >= 1);
      const [closed] = (await sql("SELECT state,reason,encrypted_value_json FROM data.norn_shadow_comparisons WHERE comparison_id=$1",[input.comparisonId])).rows;
      assert.deepEqual(closed,{ state: "incomplete",reason: "source_ended",encrypted_value_json: null });
      assert.ok((await repo().report(input)).transitions.some(item => item.reason === "source_ended"));
      // Model removal of this selected source without expiring unrelated legacy work.
      await sql("UPDATE data.norn_shadow_comparisons SET source_binding_id='removed-source' WHERE comparison_id=$1",[input.comparisonId]);
      const cleaned = await repo().maintain(randomUUID());
      assert.deepEqual(cleaned.map(row => ({ comparison_id: row.comparison_id,action: row.action })),[{ comparison_id: input.comparisonId,action: "deleted" }]);
      assert.equal((await sql("SELECT 1 FROM data.norn_shadow_observations WHERE comparison_id=$1",[input.comparisonId])).rowCount,0);
      assert.equal((await sql("SELECT 1 FROM data.norn_shadow_transitions WHERE comparison_id=$1",[input.comparisonId])).rowCount,0);
      assert.equal((await sql("SELECT 1 FROM data.agent_message_executions WHERE binding_id='binding'")).rowCount,1);
    });
    await t.test("placement epochs fence stale workers and require a fresh admission",async () => {
      const { input } = await admit();
      await sql("UPDATE control.space_placement SET placement_epoch=2 WHERE space_id='space'");
      await assert.rejects(step(input,0),DatabasePlacementStaleError);
      const moved = new PostgresNornShadowRepository(database,{ ...placement,placementEpoch: 2 },key,nornShadowEvaluator);
      assert.equal((await moved.step({ ...input,expectedRevision: 0 })).reason,"authority_changed");
    });
  } finally { await database?.close(); await f.close(); }
});
