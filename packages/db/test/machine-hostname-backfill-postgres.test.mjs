import { integration, isolatedPostgres, assertMigrationTooLarge } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";


integration("hostname backfill preserves existing observations and Space audit scope, and refuses an oversized rewrite", async () => {
  const migration = await readFile(new URL("../migrations/0132_contract_copy_machine_hostname.sql", import.meta.url), "utf8");
  const isolated = await isolatedPostgres("hostname_backfill", { migrate: false, runtimeRole: false });
  const { client } = isolated;
  try {
    await client.query(`CREATE SCHEMA data;
      CREATE TABLE data.machine_daemons (daemon_id text PRIMARY KEY,host_id text,host_name text,hostname text);
      CREATE TABLE data.workspaces (id text PRIMARY KEY,metadata_json jsonb);
      CREATE TABLE data.runs (id text PRIMARY KEY,metadata_json jsonb);
      CREATE TABLE data.secret_grant_audit (command_id text PRIMARY KEY,action text,machine_id text,host_id text,space_id text);
      INSERT INTO data.machine_daemons SELECT 'daemon:'||n,'legacy-host','observed-host',NULL FROM generate_series(1,1001) n;
      INSERT INTO data.machine_daemons VALUES ('kept','old','old','current');
      INSERT INTO data.workspaces VALUES ('one','{"machineId":"machine:one","hostId":"legacy","hostName":"observed"}'),
        ('kept','{"hostname":"current","hostId":"old"}'),('missing','{"machineId":"machine:two"}');
      INSERT INTO data.runs VALUES ('one','{"machineId":"machine:one","hostId":"legacy","executionKey":"execution:one"}');
      INSERT INTO data.secret_grant_audit VALUES ('space','space_read',NULL,'space:one',NULL),
        ('machine','grant','machine:one','hostname',NULL),('kept','space_read',NULL,'old','space:kept');`);
    for (let i=0; i<2; i++) {
      await client.query("BEGIN"); await client.query(migration); await client.query("COMMIT");
    }
    assert.equal((await client.query("SELECT count(*)::int AS n FROM data.machine_daemons WHERE hostname='observed-host'")).rows[0].n,1001);
    assert.equal((await client.query("SELECT hostname FROM data.machine_daemons WHERE daemon_id='kept'")).rows[0].hostname,"current");
    assert.deepEqual((await client.query("SELECT metadata_json FROM data.workspaces WHERE id='one'")).rows[0].metadata_json,
      { machineId:"machine:one",hostId:"legacy",hostName:"observed",hostname:"observed" });
    assert.deepEqual((await client.query("SELECT metadata_json FROM data.runs WHERE id='one'")).rows[0].metadata_json,
      { machineId:"machine:one",hostId:"legacy",hostname:"legacy",executionKey:"execution:one" });
    assert.equal((await client.query("SELECT metadata_json->>'hostname' AS hostname FROM data.workspaces WHERE id='kept'")).rows[0].hostname,"current");
    assert.equal((await client.query("SELECT metadata_json ? 'hostname' AS present FROM data.workspaces WHERE id='missing'")).rows[0].present,false);
    assert.deepEqual((await client.query("SELECT command_id,space_id FROM data.secret_grant_audit ORDER BY command_id")).rows,
      [{command_id:"kept",space_id:"space:kept"},{command_id:"machine",space_id:null},{command_id:"space",space_id:"space:one"}]);
    await client.query("INSERT INTO data.machine_daemons SELECT 'large:'||n,'host',NULL,NULL FROM generate_series(1,100001) n");
    await assertMigrationTooLarge(client, migration, "SELECT count(*)::int AS n FROM data.machine_daemons WHERE hostname IS NULL");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await isolated.close();
  }
});
