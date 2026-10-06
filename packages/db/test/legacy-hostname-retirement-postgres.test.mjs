import { isolatedPostgres, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const migration = await readFile(new URL("../migrations/0137_contract_retire_legacy_hostname.sql", import.meta.url), "utf8");
const observationTables = ["agent_launches", "agent_reborn_intents", "machine_daemon_commands", "machine_daemons",
  "machine_run_routes", "machine_run_snapshot_heads", "machine_run_terminal_reports", "registration_stop_intents"];

async function fixture(body) {
  const isolated = await isolatedPostgres("hostname_retirement", { migrate: false, runtimeRole: false });
  const { client, url } = isolated;
  try {
    await client.query("CREATE SCHEMA data");
    for (const table of observationTables) {
      await client.query(`CREATE TABLE data.${table} (owner_user_id text NOT NULL, machine_id text NOT NULL,
        hostname text, host_id text, metadata_json jsonb NOT NULL DEFAULT '{}',
        channel_id text NOT NULL DEFAULT 'channel', connection_epoch bigint NOT NULL DEFAULT 7,
        execution_key text NOT NULL DEFAULT 'exact-execution')`);
      await client.query(`INSERT INTO data.${table} (owner_user_id,machine_id,hostname,host_id)
        VALUES ('owner','machine:exact','current-observation','historical-computer')`);
    }
    for (const table of ["machine_daemons", "machine_run_terminal_reports"]) {
      await client.query(`ALTER TABLE data.${table} ADD COLUMN host_name text`);
    }
    await client.query(`ALTER TABLE data.machine_run_snapshot_heads ADD PRIMARY KEY (owner_user_id,machine_id,channel_id);
      ALTER TABLE data.machine_run_snapshot_heads ADD UNIQUE (owner_user_id,machine_id,host_id,channel_id);
      CREATE TABLE data.workspaces (id integer PRIMARY KEY,metadata_json jsonb NOT NULL);
      CREATE TABLE data.runs (id integer PRIMARY KEY,metadata_json jsonb NOT NULL);
      CREATE TABLE data.machines (machine_id text PRIMARY KEY,name text NOT NULL);
      INSERT INTO data.machines VALUES ('machine:exact','Laptop');
      CREATE TABLE data.secret_grant_audit (command_id text PRIMARY KEY,action text NOT NULL,machine_id text,host_id text,space_id text);
      INSERT INTO data.secret_grant_audit VALUES
        ('space-read','space_read',NULL,'space:exact',NULL),
        ('machine-read','read','machine:exact','historical-computer',NULL)`);
    const apply = async () => {
      await client.query("BEGIN");
      try { await client.query(migration); await client.query("COMMIT"); }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    };
    await body(client, apply, url.toString());
  } finally {
    await isolated.close();
  }
}

integration("legacy hostname contraction is idempotent and preserves exact identities, executions and Space audit evidence", async () => {
  await fixture(async (client, apply) => {
    const legacy = { ownerUserId: "owner", machineId: "machine:exact", executionKey: "exact-execution",
      machineName: "Laptop", hostId: "old-id", hostName: "old-observation" };
    await client.query("INSERT INTO data.workspaces VALUES (1,$1),(2,$2)",
      [legacy, { ...legacy, hostname: "preferred-observation" }]);
    await client.query("INSERT INTO data.runs VALUES (1,$1),(2,$2)", [legacy, { ...legacy, hostname: null }]);
    await client.query("UPDATE data.machine_daemons SET metadata_json=$1", [legacy]);
    await apply(); await apply();
    assert.deepEqual((await client.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='data' AND column_name IN ('host_id','host_name')`)).rows, []);
    const { hostId: _hostId, hostName: _hostName, ...identity } = legacy;
    assert.deepEqual((await client.query("SELECT metadata_json FROM data.workspaces ORDER BY id")).rows,
      [{ metadata_json: { ...identity, hostname: "old-observation" } },
        { metadata_json: { ...identity, hostname: "preferred-observation" } }]);
    assert.deepEqual((await client.query("SELECT metadata_json FROM data.runs ORDER BY id")).rows,
      [{ metadata_json: { ...identity, hostname: "old-observation" } }, { metadata_json: { ...identity, hostname: null } }]);
    assert.deepEqual((await client.query("SELECT * FROM data.machines")).rows, [{ machine_id: "machine:exact", name: "Laptop" }]);
    for (const table of observationTables) {
      assert.deepEqual((await client.query(`SELECT owner_user_id,machine_id,hostname,connection_epoch,execution_key FROM data.${table}`)).rows,
        [{ owner_user_id: "owner", machine_id: "machine:exact", hostname: "current-observation", connection_epoch: "7", execution_key: "exact-execution" }]);
    }
    assert.deepEqual((await client.query("SELECT command_id,machine_id,space_id FROM data.secret_grant_audit ORDER BY command_id")).rows,
      [{ command_id: "machine-read", machine_id: "machine:exact", space_id: null },
        { command_id: "space-read", machine_id: null, space_id: "space:exact" }]);
  });
});

integration("legacy contraction refuses missing replacement columns before metadata mutation", async () => {
  await fixture(async (client, apply) => {
    await client.query("INSERT INTO data.workspaces VALUES (1,'{\"hostId\":\"legacy\"}')");
    await client.query("ALTER TABLE data.machine_run_routes DROP COLUMN hostname");
    await assert.rejects(apply(), /no replacement hostname column/);
    assert.equal((await client.query("SELECT metadata_json->>'hostId' AS host FROM data.workspaces")).rows[0].host, "legacy");
    assert.equal((await client.query("SELECT host_id FROM data.agent_launches")).rows[0].host_id, "historical-computer");
  });
});

integration("legacy contraction refuses oversized metadata and preserves the rollback boundary", async () => {
  await fixture(async (client, apply) => {
    await client.query(`INSERT INTO data.workspaces SELECT id,'{"hostId":"legacy"}'::jsonb FROM generate_series(1,100001) id`);
    await assert.rejects(apply(), /exceeds 100000 rows/);
    assert.equal((await client.query("SELECT count(*) FROM data.workspaces WHERE metadata_json ? 'hostId'")).rows[0].count, "100001");
    assert.equal((await client.query("SELECT host_id FROM data.agent_launches")).rows[0].host_id, "historical-computer");
  });
});

integration("legacy contraction waits at most its lock budget and changes nothing behind a busy writer", async () => {
  await fixture(async (client, apply, url) => {
    const writer = new Client({ connectionString: url }); await writer.connect();
    try {
      await writer.query("BEGIN"); await writer.query("LOCK TABLE data.machine_run_routes IN ROW EXCLUSIVE MODE");
      await assert.rejects(apply(), /lock timeout/);
      assert.equal((await client.query("SELECT host_id FROM data.agent_launches")).rows[0].host_id, "historical-computer");
    } finally { await writer.query("ROLLBACK"); await writer.end(); }
  });
});
