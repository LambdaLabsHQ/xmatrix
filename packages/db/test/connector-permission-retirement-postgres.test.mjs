import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beginTestSchema, connectionString, integration } from "./postgres-database.fixture.mjs";

// The deployment guard must detect changed production evidence before retiring
// authority; permission repository cases cannot prove this migration boundary.
integration("Channel-policy retirement refuses changed evidence, freezes writers, then drops rules while preserving app permissions", async () => {
  const client = new Client({ connectionString }); await client.connect();
  try {
    const rewrite = await beginTestSchema(client, `retire_policy_${crypto.randomUUID().replaceAll("-", "")}`);
    await client.query(rewrite("CREATE TABLE data.app_connector_action_policies (mode text NOT NULL)"));
    await client.query(rewrite("CREATE TABLE data.app_connector_connections (connection_id text)"));
    const source = rewrite(await readFile(new URL("../migrations/0226_expand_connector_permission.sql", import.meta.url), "utf8"));
    await client.query(rewrite("INSERT INTO data.app_connector_action_policies VALUES ('deny')"));
    await client.query("SAVEPOINT refusal");
    await assert.rejects(client.query(source), /fresh restrictive-rule migration/u);
    await client.query("ROLLBACK TO SAVEPOINT refusal");
    assert.equal((await client.query(rewrite("SELECT mode FROM data.app_connector_action_policies"))).rows[0].mode, "deny");
    await client.query(rewrite("DELETE FROM data.app_connector_action_policies"));
    await client.query(rewrite("INSERT INTO data.app_connector_action_policies VALUES ('allow')"));
    await client.query(source);
    assert.equal((await client.query(rewrite("SELECT count(*)::int AS n FROM data.app_connector_action_policies"))).rows[0].n, 1);
    for (const sql of ["INSERT INTO data.app_connector_action_policies VALUES ('allow')", "UPDATE data.app_connector_action_policies SET mode='deny'"]) {
      await client.query("SAVEPOINT old_writer");
      await assert.rejects(client.query(rewrite(sql)), error => error.code === "23514");
      await client.query("ROLLBACK TO SAVEPOINT old_writer");
    }
    await client.query(rewrite("INSERT INTO data.app_connector_connections (connection_id,permission_mode) VALUES ('r','read'),('a','ask'),('w','write')"));
    await client.query(rewrite(await readFile(new URL("../migrations/0227_contract_retire_channel_permissions.sql", import.meta.url), "utf8")));
    assert.equal((await client.query(rewrite("SELECT to_regclass('data.app_connector_action_policies') AS retired"))).rows[0].retired, null);
    assert.deepEqual((await client.query(rewrite("SELECT permission_mode FROM data.app_connector_connections ORDER BY connection_id"))).rows.map(row => row.permission_mode), ["ask", "read", "write"]);
  } finally { await client.query("ROLLBACK").catch(() => {}); await client.end(); }
});
