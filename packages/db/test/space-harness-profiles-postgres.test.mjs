import assert from "node:assert/strict";
import { connectorDatabase, beginTestSchema, applyTestMigrations, integration } from "./postgres-database.fixture.mjs";

// The description routing reads moved from each registration to one profile
// per Space and harness. Whatever people had written must survive the move:
// dropped text would silently change which Agent is picked.
integration("descriptions written on registrations become their harness's profile", async () => {
  const { client } = await connectorDatabase("harness_profile_backfill");
  try {
    const rewrite = await beginTestSchema(client, "harness_profile_backfill");
    const sql = (text, values) => client.query(rewrite(text), values);
    await sql(`CREATE TABLE data.space_agent_registrations (space_id text,machine_id text,harness text,configuration_json jsonb)`);
    const routing = description => JSON.stringify({ workspaceReferences: [], routing: { description } });
    await sql(`INSERT INTO data.space_agent_registrations VALUES ('a','m1','codex',$1),('a','m2','codex',$2),
      ('a','m3','codex',$1),('a','m1','claude',$3),('a','m1','gemini','{"workspaceReferences":[]}'),('b','m1','codex',$4)`,
    [routing("Audits code."), routing(" Backend only "), routing("   "), routing("x".repeat(1200))]);
    await applyTestMigrations(client, ["0185_expand_space_harness_profiles.sql"], rewrite);
    assert.deepEqual((await sql(`SELECT space_id,harness,description,revision::int FROM data.space_harness_profiles
      ORDER BY space_id,harness`)).rows, [
      { space_id: "a", harness: "codex", description: "Audits code.\nBackend only", revision: 1 },
      { space_id: "b", harness: "codex", description: "x".repeat(1000), revision: 1 }]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
