import { integration, migrationFixture } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";

// 0082 removes persisted model entries equal to their own row's harness name,
// without advancing any authorization fence a live execution depends on.
const MIGRATION = "0082_contract_remove_harness_named_models";

integration("0082 strips harness-named models from every persisted model list and keeps execution fences", async () => {
  const fixture = await migrationFixture("harness_models", MIGRATION);
  const { client, run, source } = fixture;
  try {

    // Rows written by the removed placeholder code, plus rows that must not change.
    await run(`INSERT INTO data.agent_registrations VALUES
      ('owner','machine','claude',1,now(),now()),('owner','machine','codex',1,now(),now())`);
    await run(`INSERT INTO control.machine_execution_capacity (owner_user_id,machine_id,max_concurrent,version)
      VALUES ('owner','machine',2,1)`);
    const environment = models => JSON.stringify({ schemaVersion: 1, enabled: true, models, description: "",
      availability: "interactive", capabilities: [] });
    await run(`INSERT INTO control.agent_registration_environments (owner_user_id,machine_id,harness,declaration_json,version)
      VALUES ('owner','machine','claude',$1::jsonb,3),('owner','machine','codex',$2::jsonb,5)`, [
      JSON.stringify({ ...JSON.parse(environment(["claude", "opus"])), modelAliases: { claude: "x", opus: "claude-opus" } }),
      environment(["gpt-5"])]);
    const configuration = (models, model) => JSON.stringify({ workspaceReferences: ["ws"], secretReferences: [],
      ...(model ? { model } : {}), routing: { schemaVersion: 1, enabled: true, models, description: "" } });
    await run(`INSERT INTO data.space_agent_registrations VALUES
      ('space','owner','machine','claude','Claude',$1::jsonb,4,now(),now()),
      ('space','owner','machine','codex','Codex',$2::jsonb,7,now(),now())`,
    [configuration(["claude"], "claude"), configuration(["gpt-5"], "gpt-5")]);
    const limits = models => JSON.stringify({ workspaces: ["ws"], models, secrets: [], capabilities: [] });
    await run(`INSERT INTO data.space_agent_registration_access (space_id,owner_user_id,machine_id,harness,
        grant_state,grant_revision,grant_execution_revision,grant_limits,policy_state,policy_revision,policy_execution_revision,policy_limits,updated_at)
      VALUES ('space','owner','machine','claude','active',6,5,$1::jsonb,'enabled',9,8,$1::jsonb,now()),
        ('space','owner','machine','codex','active',2,2,$2::jsonb,'enabled',3,3,$2::jsonb,now())`,
    [limits(["claude"]), limits(["gpt-5"])]);
    const profile = (models, extra = {}) => JSON.stringify({ machineId: "machine",
      routing: { schemaVersion: 1, enabled: true, models, description: "", availability: "unknown", capabilities: [], ...extra } });
    await run(`INSERT INTO data.agent_profiles (agent_profile_id,space_id,owner_user_id,name,runtime,version,metadata_json,created_at,updated_at)
      VALUES ('p-claude','space','owner','claude','claude_code',2,$1::jsonb,now(),now()),
        ('p-codex','space','owner','codex','codex',4,$2::jsonb,now(),now()),
        ('p-plain','space','owner','plain','grok',1,'{"machineId":"machine"}',now(),now())`,
    [profile(["claude_code", "claude", "sonnet"]), profile(["codex", "gpt-5"], { modelAliases: { codex: "gpt-5" } })]);
    await run(`INSERT INTO control.legacy_agent_registration_references VALUES ('p-claude','space','owner','machine','claude',now())`);

    const snapshot = async () => ({
      environments: await run(`SELECT harness,declaration_json->'models' AS models,declaration_json->'modelAliases' AS aliases,version
        FROM control.agent_registration_environments ORDER BY harness`),
      configurations: await run(`SELECT harness,configuration_json->'model' AS model,configuration_json->'routing'->'models' AS models,version
        FROM data.space_agent_registrations ORDER BY harness`),
      access: await run(`SELECT harness,grant_limits->'models' AS grant_models,policy_limits->'models' AS policy_models,
        grant_revision,grant_execution_revision,policy_revision,policy_execution_revision
        FROM data.space_agent_registration_access ORDER BY harness`),
      profiles: await run(`SELECT agent_profile_id,metadata_json->'routing'->'models' AS models,
        metadata_json->'routing'->'modelAliases' AS aliases,version FROM data.agent_profiles ORDER BY agent_profile_id`),
    });
    await client.query(source);
    const after = await snapshot();
    assert.deepEqual(after.environments, [
      { harness: "claude", models: ["opus"], aliases: { opus: "claude-opus" }, version: "3" },
      { harness: "codex", models: ["gpt-5"], aliases: null, version: "5" }]);
    assert.deepEqual(after.configurations, [
      { harness: "claude", model: null, models: [], version: "5" },
      { harness: "codex", model: "gpt-5", models: ["gpt-5"], version: "7" }]);
    // Fences stay put, so no starting Run, staged launch or continuation is revoked.
    assert.deepEqual(after.access, [
      { harness: "claude", grant_models: [], policy_models: [], grant_revision: "6", grant_execution_revision: "5",
        policy_revision: "9", policy_execution_revision: "8" },
      { harness: "codex", grant_models: ["gpt-5"], policy_models: ["gpt-5"], grant_revision: "2", grant_execution_revision: "2",
        policy_revision: "3", policy_execution_revision: "3" }]);
    assert.deepEqual(after.profiles, [
      { agent_profile_id: "p-claude", models: ["sonnet"], aliases: null, version: "2" },
      { agent_profile_id: "p-codex", models: ["gpt-5"], aliases: {}, version: "4" },
      { agent_profile_id: "p-plain", models: null, aliases: null, version: "1" }]);
    // Idempotent: nothing left to rewrite, and no version advances again.
    await client.query(source);
    assert.deepEqual(await snapshot(), after);

    // A live Run admitted for the placeholder does not block the rewrite.
    await run(`UPDATE data.space_agent_registration_access SET grant_limits=$1::jsonb WHERE harness='claude'`, [limits(["claude"])]);
    await run(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,created_at,updated_at)
      VALUES ('channel:1#1','owner','channel','running',1,now(),now())`);
    await run(`INSERT INTO data.run_agent_registrations (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,
        allocation_id,authorization_digest,grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
      VALUES ('channel:1#1','space','owner','machine','claude','owner','allocation',repeat('a',64),6,5,9,8,$1::jsonb)`, [limits(["claude", "opus"])]);
    await run(`INSERT INTO data.registration_launch_intents (actor_user_id,command_id,request_digest,space_id,owner_user_id,
        machine_id,harness,channel_id,source_message_id,selection_index,source_body_hash,source_revision,run_id,instance_id,
        launch_id,execution_key,control_id,authorization_digest,grant_revision,grant_execution_revision,policy_revision,
        policy_execution_revision,resources_json,configuration_json,display_name,state)
      VALUES ('owner','cmd',repeat('b',64),'space','owner','machine','claude','channel','msg',0,repeat('c',64),1,
        'prep-run','inst','launch','exec','ctrl',repeat('d',64),6,5,9,8,$1::jsonb,'{}'::jsonb,'Claude','preparing')`,
    [limits(["claude"])]);
    await client.query(source);
    assert.deepEqual((await run(`SELECT grant_limits->'models' AS models, grant_revision, grant_execution_revision
      FROM data.space_agent_registration_access WHERE harness='claude'`))[0],
    { models: [], grant_revision: "6", grant_execution_revision: "5" });
    assert.deepEqual((await run(`SELECT status FROM data.runs WHERE run_id='channel:1#1'`))[0].status, "running");
    assert.deepEqual((await run(`SELECT requested_json->'models' AS models FROM data.run_agent_registrations
      WHERE run_id='channel:1#1'`))[0].models, ["opus"]);
    assert.deepEqual((await run(`SELECT resources_json->'models' AS models, state FROM data.registration_launch_intents
      WHERE command_id='cmd'`))[0], { models: [], state: "preparing" });
  } finally { await fixture.close(); }
});
