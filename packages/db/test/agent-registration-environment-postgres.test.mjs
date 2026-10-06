import { connectionString as url, integration, beginTestSchema, savepointDatabase, applyTestMigrations } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { Client } from "pg";
import { PostgresAgentEnvironmentRepository } from "../dist/index.js";


integration("physical declarations have an owner-only CAS boundary without machine limits", async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  const schema = `registration_environment_${process.pid}`;
  try {
    const rewrite = await beginTestSchema(client, schema);
    await applyTestMigrations(client, ["0059_expand_agent_registration_keys.sql", "0065_expand_registration_environment.sql"], rewrite);
    await client.query(`CREATE TABLE ${schema}.machine_daemons (owner_user_id text,machine_id text)`);
    await client.query(`INSERT INTO ${schema}.machine_daemons VALUES ('owner','machine')`);
    for (const harness of ["codex", "claude"]) await client.query(`INSERT INTO ${schema}.agent_registrations
      VALUES ('owner','machine',$1,1,now(),now())`, [harness]);
    const database = savepointDatabase(client, rewrite, context => { assert.equal(context.placement, undefined, "physical declarations must use the directory connection"); });
    const repository = new PostgresAgentEnvironmentRepository(database);
    const key = { ownerUserId: "owner", machineId: "machine", harness: "codex" };
    const environment = { schemaVersion: 1, enabled: true, models: ["model-a"], description: "Interactive development",
      availability: "interactive", capabilities: [] };
    const command = { key, actorUserId: "owner", commandId: "environment-codex", expectedVersion: 0,
      expectedMachineVersion: 0, machineMaxConcurrent: 2, environment };
    const get = { key, actorUserId: "owner", requestId: "get" };
    assert.equal((await repository.get(get)).environment, null);
    await assert.rejects(() => repository.change({ ...command, actorUserId: "space-admin" }), error => error.code === "registration_not_found");
    assert.deepEqual(await repository.change(command), { key, version: 1, reused: false });
    assert.deepEqual(await repository.change(command), { key, version: 1, reused: true });
    assert.equal((await repository.change({ ...command, machineMaxConcurrent: 3 })).reused, true);
    await assert.rejects(() => repository.change({ ...command, commandId: "stale" }), error => error.code === "environment_version_conflict");
    const claude = { ...command, key: { ...key, harness: "claude" }, commandId: "environment-claude", expectedMachineVersion: 1 };
    assert.equal((await repository.change(claude)).version, 1);
    await repository.change({ ...command, commandId: "raise-machine", expectedVersion: 1, expectedMachineVersion: 1, machineMaxConcurrent: 3 });
    assert.equal((await repository.change({ ...claude, commandId: "independent-harness", expectedVersion: 1 })).version, 2);
    const current = await repository.get(get);
    assert.equal(current.version, 2);
    assert.equal(Object.hasOwn(current, "machineMaxConcurrent"), false);
    assert.equal(Object.hasOwn(current, "machineVersion"), false);
    assert.deepEqual(current.environment, environment);
    await assert.rejects(() => repository.get({ ...get, actorUserId: "space-admin" }), error => error.code === "registration_not_found");
    await assert.rejects(() => repository.change({ ...command, environment: { ...environment, defaultWorkspace: "/private-space-path" } }), /Space workspace/);
    await assert.rejects(() => repository.change({ ...command, environment: { ...environment, apiKey: "not-a-real-secret" } }), /routing field/);
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${schema}.space_agent_registrations`)).rows[0].n, 0,
      "physical configuration must not share or enable any Space");
  } finally { await client.query("ROLLBACK"); await client.end(); }
});
