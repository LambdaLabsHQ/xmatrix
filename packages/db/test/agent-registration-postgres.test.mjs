import { connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";


integration("registration primary keys and Space references enforce the complete natural tuple", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  const schema = `registration_test_${process.pid}`;
  const at = "2026-09-20T00:00:00Z";
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    const sql = await readFile(new URL("../migrations/0059_expand_agent_registration_keys.sql", import.meta.url), "utf8");
    await client.query(sql.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`));
    const insert = (owner, machine, harness) => client.query(`INSERT INTO ${schema}.agent_registrations
      VALUES ($1,$2,$3,1,$4,$4)`, [owner, machine, harness, at]);
    const fails = async (operation, code) => {
      await client.query("SAVEPOINT expected_error");
      await assert.rejects(operation, error => error.code === code);
      await client.query("ROLLBACK TO SAVEPOINT expected_error");
    };
    await insert("owner", "machine", "codex");
    await fails(() => insert("owner", "machine", "codex"), "23505");
    await insert("other-owner", "machine", "codex");
    await insert("owner", "other-machine", "codex");
    await insert("owner", "machine", "claude");
    await fails(() => insert("owner", "machine", "custom"), "23514");
    const primary = await client.query(`SELECT a.attname FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum,position)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
      WHERE c.conrelid=$1::regclass AND c.contype='p' ORDER BY k.position`, [`${schema}.agent_registrations`]);
    assert.deepEqual(primary.rows.map(row => row.attname), ["owner_user_id", "machine_id", "harness"]);
    for (const space of ["space-a", "space-b"]) await client.query(`INSERT INTO ${schema}.space_agent_registrations
      VALUES ($1,'owner','machine','codex','codex','{}',1,$2,$2)`, [space, at]);
    await fails(() => client.query(`INSERT INTO ${schema}.space_agent_registrations
      VALUES ('space-a','owner','missing-machine','codex','codex','{}',1,$1,$1)`, [at]), "23503");
    await client.query(`UPDATE ${schema}.space_agent_registrations SET display_name='renamed',version=2
      WHERE space_id='space-a' AND owner_user_id='owner' AND machine_id='machine' AND harness='codex'`);
    await client.query(`UPDATE ${schema}.space_agent_registrations SET configuration_json='{"model":"space-a-model"}'
      WHERE space_id='space-a' AND owner_user_id='owner' AND machine_id='machine' AND harness='codex'`);
    assert.deepEqual((await client.query(`SELECT configuration_json FROM ${schema}.space_agent_registrations
      WHERE space_id='space-b'`)).rows[0].configuration_json, {});
    await client.query(`INSERT INTO ${schema}.legacy_agent_registration_references
      VALUES ('legacy-profile','space-a','owner','machine','codex',$1)`, [at]);
    await fails(() => client.query(`INSERT INTO ${schema}.legacy_agent_registration_references
      VALUES ('wrong-space','space-c','owner','machine','codex',$1)`, [at]), "23503");
    assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM ${schema}.agent_registrations`)).rows[0].n, 4);
    assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM ${schema}.space_agent_registrations`)).rows[0].n, 2);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
