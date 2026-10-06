import { connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const at = "2026-10-02T00:00:00.000Z";

integration("0127 turns GitHub write channels into allow policies once, only for channels of the same Space", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const migration = await readFile(new URL("../migrations/0127_expand_github_write_policies.sql", import.meta.url), "utf8");
  const client = new Client({ connectionString });
  await client.connect();
  const space = `gh-policy-${crypto.randomUUID()}`;
  const other = `${space}-other`;
  const sql = (text, values) => client.query(text, values);
  try {
    await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES ($2||':ops',$2,'ops','ops','open',$2||':r1',1,$1,$1),($3||':foreign',$3,'f','f','open',$3||':r2',1,$1,$1)`,
    [at, space, other]);
    await sql(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
       capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at,metadata_json)
      VALUES ($2,$2||':github',1,'github','GitHub','configured','oauth','[]','[]','[]','[]','owner',$2||':rank',$1,$1,$3::jsonb)`,
    [at, space, JSON.stringify({ actionsWriteChannelId: `${space}:ops`, closeReopenWriteChannelId: `${space}:ops`,
      commentWriteChannelId: `${other}:foreign`, reviewWriteChannelId: "" })]);
    await sql(`INSERT INTO data.app_connector_action_policies
      (connection_id,channel_id,action_id,space_id,mode,version,updated_by,created_at,updated_at)
      VALUES ($2||':github',$2||':ops','dispatch_workflow',$2,'deny',1,'owner',$1,$1)`, [at, space]);
    await client.query("BEGIN");
    await client.query(migration);
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query(migration);
    await client.query("COMMIT");
    const rows = (await sql(`SELECT channel_id,action_id,mode FROM data.app_connector_action_policies
      WHERE space_id=$1 ORDER BY action_id`, [space])).rows;
    assert.deepEqual(rows, [
      { channel_id: `${space}:ops`, action_id: "close_issue", mode: "allow" },
      { channel_id: `${space}:ops`, action_id: "dispatch_workflow", mode: "deny" },
      { channel_id: `${space}:ops`, action_id: "reopen_issue", mode: "allow" },
      { channel_id: `${space}:ops`, action_id: "rerun_failed_jobs", mode: "allow" },
    ], "a foreign or empty channel is ignored and an existing policy is kept");
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    for (const table of ["app_connector_action_policies", "app_connector_connections", "channels"]) {
      await sql(`DELETE FROM data.${table} WHERE space_id=$1 OR space_id=$2`, [space, other]);
    }
    await client.end();
  }
});
