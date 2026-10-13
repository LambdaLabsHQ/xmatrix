import assert from "node:assert/strict";
import { connectorDatabase, beginTestSchema, applyTestMigrations, integration } from "./postgres-database.fixture.mjs";

// Domain cancellation tests already protect reservation fencing. This schema
// test protects its bounded queue read as completed abort history accumulates;
// a row limit alone cannot catch scanning and sorting all that history.
integration("unfinished launch cancellations remain an ordered bounded scan after completed history grows", async () => {
  const { client } = await connectorDatabase("launch_cancel_index");
  try {
    const rewrite = await beginTestSchema(client, "launch_cancel_index");
    const sql = (text, values) => client.query(rewrite(text), values);
    await sql(`CREATE TABLE data.registration_launch_intents (
      run_id text PRIMARY KEY, channel_id text NOT NULL, state text NOT NULL,
      cancellation_completed boolean NOT NULL, next_check_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL);
      CREATE TABLE data.runs (run_id text PRIMARY KEY);
      CREATE INDEX channel_open ON data.registration_launch_intents (channel_id,next_check_at)
        WHERE state IN ('preparing','aborted')`);
    await sql(`INSERT INTO data.registration_launch_intents
      SELECT 'done-'||n,'channel','aborted',true,now(),now()
      FROM generate_series(1,20000) n;
      INSERT INTO data.registration_launch_intents
      SELECT 'pending-'||lpad(n::text,2,'0'),'channel','aborted',false,now(),
        '2026-10-01'::timestamptz + (n/2)*interval '1 second'
      FROM generate_series(1,20) n;
      INSERT INTO data.registration_launch_intents VALUES
        ('other','other-channel','aborted',false,now(),'2026-09-01'),
        ('preparing','channel','preparing',false,now(),'2026-09-01');
      INSERT INTO data.runs VALUES ('pending-01')`);
    await applyTestMigrations(client, ["0184_expand_registration_launch_cancel_index.sql"], rewrite);
    await sql("ANALYZE data.registration_launch_intents; ANALYZE data.runs");
    const query = `SELECT p.run_id FROM data.registration_launch_intents p
      WHERE channel_id=$1 AND state='aborted' AND cancellation_completed=FALSE
        AND NOT EXISTS (SELECT 1 FROM data.runs r WHERE r.run_id=p.run_id)
      ORDER BY updated_at,run_id LIMIT 10`;
    assert.deepEqual((await sql(query, ["channel"])).rows.map(row => row.run_id),
      Array.from({ length: 10 }, (_, i) => `pending-${String(i + 2).padStart(2, "0")}`));
    const plan = (await sql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, ["channel"])).rows[0]["QUERY PLAN"][0].Plan;
    const nodes = function* (node) { yield node; for (const child of node.Plans ?? []) yield* nodes(child); };
    assert.ok([...nodes(plan)].every(node => node["Node Type"] !== "Sort" &&
      !(node["Node Type"] === "Seq Scan" && node["Relation Name"] === "registration_launch_intents")),
      "the queue must not scan or sort completed history");
    assert.ok(plan["Shared Hit Blocks"] < 100, "the ten-row read stays independent of completed history");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
