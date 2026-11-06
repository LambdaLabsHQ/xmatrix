import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createAuthorityDatabase, PostgresAutomationRepository } from "../dist/index.js";
import { connectionString, integration, seedTestSpacePlacement } from "./postgres-database.fixture.mjs";

// What a page Automation's occurrences produced is read from each one's own
// conversation (docs/design/pages-live-document.md §6.4): every fact comes
// from the record that owns it, found by the scheduler's conversation id, on
// the current schema and its indexes. Misplaced evidence must not count.
integration("each occurrence's facts come from its own conversation, newest ten first", async () => {
  const id = randomUUID().slice(0, 8);
  const space = `outcomes-space-${id}`, foreign = `outcomes-foreign-${id}`, owner = `outcomes-owner-${id}`;
  const client = new Client({ connectionString });
  await client.connect();
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0",
    applicationName: "automation-outcomes-test" });
  const sql = (text, values = []) => client.query(text, values);
  const at = (hours) => new Date(Date.UTC(2026, 10, 1) + hours * 3_600_000).toISOString();
  let sequence = 0;
  try {
    for (const placed of [space, foreign]) await seedTestSpacePlacement(client, placed, at(0));
    const channel = (channelId, spaceId) => sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,
      search_rank_sequence,version,created_at,updated_at) VALUES ($1,$2,$1,$1,'closed',$1,1,$3,$3)`,
    [channelId, spaceId, at(0)]);
    const automation = async (automationId, timer, spaceId, pageId) => {
      await channel(timer, spaceId);
      await sql(`INSERT INTO data.automations (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,
        payload_json,page_id,created_at,updated_at) VALUES ($1,$2,$3,$4,true,1,'{}',$5,$4,$4)`,
      [automationId, owner, timer, at(0), pageId]);
    };
    const audit = `outcomes-audit-${id}`;
    await automation(audit, `outcomes-timer-${id}`, space, `outcomes-page-${id}`);
    await automation(`outcomes-unpaged-${id}`, `outcomes-unpaged-timer-${id}`, space, null);
    await automation(`outcomes-elsewhere-${id}`, `outcomes-foreign-timer-${id}`, foreign, `outcomes-foreign-page-${id}`);
    // Twelve occurrences an hour apart, the newest first; one was cancelled.
    const statuses = ["pending", ...Array(5).fill("dispatched"), "cancelled", ...Array(4).fill("dispatched"), "failed"];
    const occurrences = [];
    for (const [index, status] of statuses.entries()) {
      const occurrenceId = `scheduled-occurrence:${id}-${index}`;
      await sql(`INSERT INTO data.automation_occurrences (occurrence_id,automation_id,automation_version,owner_user_id,
        scheduled_for,status,attempts,next_attempt_at,control_id,delivery_kind,message_id,created_at,updated_at)
        VALUES ($1,$2,1,$3,$4,$5,0,$4,$1,'message',$1,$4,$4)`, [occurrenceId, audit, owner, at(24 - index), status]);
      const conversation = (await sql("SELECT data.automation_occurrence_conversation_id($1) AS id",
        [occurrenceId])).rows[0].id;
      occurrences.push({ status, conversation });
    }
    const [, edited, reported, retried, refused, working, cancelled, purged] = occurrences.map((item) => item.conversation);

    // A page edit from one conversation; a purge and another Space's revision name a second.
    const revision = (spaceId, conversations, kind) => sql(`INSERT INTO data.page_revisions
      (space_id,page_id,revision,body,authors_json,conversation_ids,kind,created_at)
      VALUES ($1,$2,$3,'Body','[]',$4::text[],$5,$6)`,
    [spaceId, `outcomes-page-${id}`, ++sequence, conversations, kind, at(30)]);
    await revision(space, [`outcomes-other-${id}`, edited], "edit");
    await revision(space, [purged], "purge");
    await revision(foreign, [purged, cancelled], "edit");

    // Launches: retried failed once and then connected; refused only failed; working is still spawning.
    const launch = (conversation, state) => {
      const key = `outcomes-launch-${id}-${++sequence}`;
      return sql(`INSERT INTO data.agent_launches (launch_id,space_id,channel_id,trigger_id,launch_kind,owner_user_id,
        run_id,instance_id,execution_key,control_id,machine_id,state,spawn_payload_json,next_attempt_at,created_at,
        updated_at) VALUES ($1,$2,$3,'source','registration',$4,$1,$1,$1,$1,'machine',$5,'{}',$6,$6,$6)`,
      [key, space, conversation, owner, state, at(30)]);
    };
    await launch(retried, "failed");
    await launch(retried, "connected");
    await launch(refused, "failed");
    await launch(working, "spawned");
    // Run ids are their natural keys (0084): `<conversation>:<instance>#<run>`.
    await sql(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,created_at,updated_at)
      VALUES ($3||':1#1',$1,$3,'running',1,$2,$2),($4||':1#1',$1,$4,'exited',1,$2,$2)`,
    [owner, at(30), working, retried]);

    // Messages: a failure notice, and eleven activity entries of which one was deleted and one recalled.
    const message = (conversation, kind, payload, removed = {}) => {
      sequence += 1;
      return sql(`INSERT INTO data.messages (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,
        author_id,message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,created_at,
        payload_bundle_base64,deleted_at,recalled_at) VALUES ($1,$2,$3,$4,1,'agent','agent',$5,'hash','hot-inline',$3,$6,$6,
        $3,$6,$7,$8,$9)`, [space, conversation, `outcomes-message-${id}-${sequence}`, sequence, kind, at(30), payload,
        removed.deleted ? at(31) : null, removed.recalled ? at(31) : null]);
    };
    await message(refused, "xmatrix.system.runtime-failure", "notice");
    await message(reported, "xmatrix.message.text", "speech");
    for (let entry = 1; entry <= 11; entry++) await message(reported, "xmatrix.activity", `entry-${entry}`);
    await message(reported, "xmatrix.activity", "deleted", { deleted: true });
    await message(reported, "xmatrix.activity", "recalled", { recalled: true });

    const facts = await new PostgresAutomationRepository(database).recentOccurrences({ requestId: randomUUID(),
      spaceId: space, automationIds: [audit, `outcomes-unpaged-${id}`, `outcomes-elsewhere-${id}`] });
    const answered = occurrences.filter((item) => item.status !== "cancelled").slice(0, 10);
    assert.deepEqual(facts.map((fact) => [fact.automationId, fact.status, fact.conversationId]),
      answered.map((item) => [audit, item.status, item.conversation]),
      "only the Space's page Automation, its ten newest occurrences that were not cancelled, newest first");
    assert.equal(facts[0].scheduledFor, at(24));
    const of = (conversation) => facts.find((fact) => fact.conversationId === conversation);
    assert.deepEqual(facts.filter((fact) => fact.pageChanged).map((fact) => fact.conversationId), [edited],
      "a purge and another Space's revision change no page");
    assert.deepEqual(of(retried).launchStates.toSorted(), ["connected", "failed"]);
    assert.deepEqual(of(refused).launchStates, ["failed"]);
    assert.equal(of(refused).failureNotice, true);
    assert.deepEqual(facts.filter((fact) => fact.failureNotice).map((fact) => fact.conversationId), [refused]);
    assert.deepEqual(facts.filter((fact) => fact.runActive).map((fact) => fact.conversationId), [working],
      "an exited Run is not active");
    assert.deepEqual(of(working).launchStates, ["spawned"]);
    assert.deepEqual(of(reported).activityPayloads, Array.from({ length: 10 }, (_, index) => `entry-${11 - index}`),
      "its ten newest live activity entries, not its speech or removed entries");
    assert.ok(facts.every((fact) => fact.conversationId === reported || fact.activityPayloads.length === 0));
    assert.deepEqual(await new PostgresAutomationRepository(database).recentOccurrences({ requestId: randomUUID(),
      spaceId: foreign, automationIds: [audit] }), [], "another Space does not answer for this one's Automation");
  } finally {
    const prefixed = `outcomes-%${id}%`;
    for (const table of ["messages", "agent_launches", "page_revisions"]) {
      await sql(`DELETE FROM data.${table} WHERE space_id IN ($1,$2)`, [space, foreign]);
    }
    await sql("DELETE FROM data.runs WHERE owner_user_id=$1", [owner]);
    await sql("DELETE FROM data.automation_occurrences WHERE automation_id LIKE $1", [prefixed]);
    await sql("DELETE FROM data.automations WHERE automation_id LIKE $1", [prefixed]);
    await sql("DELETE FROM data.channels WHERE space_id IN ($1,$2)", [space, foreign]);
    await sql("DELETE FROM control.space_placement WHERE space_id IN ($1,$2)", [space, foreign]);
    await database.close?.();
    await client.end();
  }
});
