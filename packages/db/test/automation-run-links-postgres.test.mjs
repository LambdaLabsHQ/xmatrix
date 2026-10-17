import assert from "node:assert/strict";
import { Client } from "pg";
import { connectionString, integration, beginTestSchema, applyTestMigrations } from "./postgres-database.fixture.mjs";

// The relation itself owns exact association. Existing lifecycle tests launched
// real Runs but never checked their occurrence; this fixture additionally puts
// misleading, incomplete and cross-Space evidence through the actual SQL view.
integration("occurrences prove all committed source Runs and reject reservations, guesses and cross-Space links", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const rewrite = await beginTestSchema(client, `automation_links_${process.pid}`);
    const sql = (text, values) => client.query(rewrite(text), values);
    await sql(`CREATE TABLE data.automation_occurrences
      (occurrence_id text,automation_id text,owner_user_id text,delivery_kind text,message_id text,
       run_id text NOT NULL,instance_id text NOT NULL);
      CREATE TABLE data.automations (automation_id text,channel_id text);
      CREATE TABLE data.channels (channel_id text,space_id text);
      CREATE TABLE data.registration_launch_intents
        (space_id text,channel_id text,source_message_id text,selection_index integer,launch_id text,
         instance_id text,run_id text,owner_user_id text,machine_id text,harness text,state text);
      CREATE TABLE data.runs
        (run_id text,channel_id text,owner_user_id text,status text,created_at timestamptz,finished_at timestamptz);
      CREATE TABLE data.run_agent_registrations
        (run_id text,space_id text,owner_user_id text,machine_id text,harness text)`);
    await applyTestMigrations(client, ["0200_expand_automation_run_links.sql"], rewrite);
    const occurrence = "scheduled-occurrence:y4-fixture";
    const conversation = "cdc47c23-7b4a-5703-85d2-a468ea85ccd4";
    assert.equal((await sql("SELECT data.automation_occurrence_conversation_id($1) AS id", [occurrence])).rows[0].id,
      conversation, "the scheduler's stable conversation byte contract");
    await sql(`INSERT INTO data.channels VALUES ('root','space'),($1,'space'),('nearby','space'),('foreign-root','foreign')`, [conversation]);
    await sql(`INSERT INTO data.automations VALUES ('automation','root'),('foreign-automation','foreign-root')`);
    await sql(`INSERT INTO data.automation_occurrences VALUES
      ($1,'automation','author','message','canonical-message','unused-reservation','unused-instance'),
      ('no-agent','automation','author','message','no-summon',NULL,NULL),
      ('failed-start','automation','author','message','unstarted',NULL,NULL)`, [occurrence]);
    async function launch(id, { channel = conversation, space = "space", source = "canonical-message",
      state = "committed", run = true, binding = true, status = "starting" } = {}) {
      await sql(`INSERT INTO data.registration_launch_intents VALUES ($1,$2,$3,0,$4,$4,$4,'runner','machine','codex',$5)`,
        [space, channel, source, id, state]);
      if (run) await sql(`INSERT INTO data.runs VALUES ($1,$2,'runner',$3,now(),NULL)`, [id, channel, status]);
      if (binding) await sql(`INSERT INTO data.run_agent_registrations VALUES ($1,$2,'runner','machine','codex')`, [id, space]);
    }
    // Multiple launches and provider failure are still exact, persisted Runs.
    await launch("real-a");
    await launch("real-b", { status: "failed" });
    await launch("preparing", { state: "preparing", run: false });
    await launch("aborted", { state: "aborted" });
    await launch("reserved-only", { run: false });
    await launch("unbound", { binding: false });
    await launch("same-message-other-channel", { channel: "nearby" });
    await launch("same-channel-other-message", { source: "different-message" });
    await launch("same-ids-other-space", { space: "foreign" });
    const links = async () => (await sql(`SELECT occurrence_id,run_id,status FROM data.automation_occurrence_runs
      ORDER BY run_id`)).rows;
    const expected = [
      { occurrence_id: occurrence, run_id: "real-a", status: "starting" },
      { occurrence_id: occurrence, run_id: "real-b", status: "failed" },
    ];
    assert.deepEqual(await links(), expected);
    assert.deepEqual(await links(), expected, "replay reads the existing authority, creating no duplicate fact");
    // A moved/mis-scoped Automation cannot borrow the original Space's launches.
    await sql("UPDATE data.automation_occurrences SET automation_id='foreign-automation' WHERE occurrence_id=$1", [occurrence]);
    assert.deepEqual(await links(), []);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
