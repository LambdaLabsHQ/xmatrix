import { connectionString as url, integration, postgresConnections } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { PostgresAgentRegistrationRepository } from "../dist/index.js";


integration("Space shards share global enrollment, and interrupted sharing resumes without restoring stale authorization", async () => {
  assert.ok(url);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  const schemas = Object.fromEntries(["directory", "a", "b"].map(name => [name, `registration_shards_${process.pid}_${name}`]));
  const rewrite = (schema, text) => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  let revokeBeforeShare = false;
  try {
    for (const [name, schema] of Object.entries(schemas)) {
      await setup.query(`CREATE SCHEMA ${schema}`);
      for (const file of ["0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql",
        "0061_expand_registration_commands.sql", "0062_expand_registration_execution_revision.sql", "0067_expand_registration_grant_execution_revision.sql",
        "0063_expand_registration_authority.sql", "0064_expand_registration_enrollments.sql", "0101_expand_registration_role.sql"]) {
        await setup.query(rewrite(schema, await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")));
      }
      await setup.query(`CREATE TABLE ${schema}.space_members (space_id text,user_id text,role text)`);
      await setup.query(`CREATE TABLE ${schema}.space_member_creation_policies (space_id text,agent_creation_policy text)`);
      await setup.query(`CREATE TABLE ${schema}.machine_daemons (daemon_id text,owner_user_id text,machine_id text)`);
      if (name === "directory") await setup.query(`INSERT INTO ${schema}.machine_daemons VALUES ('daemon','owner','machine')`);
      else {
        await setup.query(`INSERT INTO ${schema}.space_members VALUES ($1,'owner','owner')`, [name]);
        await setup.query(`INSERT INTO ${schema}.agent_registration_authority
          (space_id,mode,manifest_digest,version) VALUES ($1,'composite',repeat('a',64),1)`, [name]);
      }
    }
    const database = postgresConnections(undefined, {
      rewrite: (text, context) => rewrite(schemas[context.placement?.shardId ?? "directory"], text),
      checkContext: async context => {
        const schema = schemas[context.placement?.shardId ?? "directory"];
        assert.ok(schema);
        if (revokeBeforeShare && context.operation === "registration.offer") {
          revokeBeforeShare = false;
          await setup.query(`DELETE FROM ${schema}.space_members WHERE user_id='owner'`);
        }
      },
    });
    const repository = spaceId => new PostgresAgentRegistrationRepository(database, { spaceId, shardId: spaceId, placementEpoch: 1 });
    const offer = spaceId => ({ key: { spaceId, ownerUserId: "owner", machineId: "machine", harness: "codex" },
      actorUserId: "owner", commandId: `offer-${spaceId}`, displayName: `codex-${spaceId}` });
    await repository("a").offer(offer("a"));
    revokeBeforeShare = true;
    await assert.rejects(() => repository("b").offer(offer("b")), error => error.code === "registration_not_found");
    const count = async (schema, table) => (await setup.query(`SELECT count(*)::int n FROM ${schema}.${table}`)).rows[0].n;
    assert.equal(await count(schemas.directory, "agent_registrations"), 1);
    assert.equal(await count(schemas.directory, "agent_registration_enrollments"), 2);
    assert.equal(await count(schemas.b, "space_agent_registrations"), 0);
    await assert.rejects(() => repository("b").offer(offer("b")), error => error.code === "registration_not_found");
    await setup.query(`INSERT INTO ${schemas.b}.space_members VALUES ('b','owner','owner')`);
    await assert.rejects(() => repository("b").offer({ ...offer("b"), displayName: "changed" }), error => error.code === "idempotency_mismatch");
    await repository("b").offer(offer("b"));
    assert.equal(await count(schemas.directory, "agent_registrations"), 1);
    for (const name of ["a", "b"]) {
      assert.equal(await count(schemas[name], "agent_registration_enrollments"), 0, "enrollment replay is global only");
      assert.equal(await count(schemas[name], "agent_registrations"), 1, "only the composite FK anchor is projected");
      assert.equal(await count(schemas[name], "space_agent_registrations"), 1);
      assert.equal((await repository(name).get({ key: offer(name).key, actorUserId: "owner", requestId: "read" })).displayName, `codex-${name}`);
    }
  } finally {
    for (const schema of Object.values(schemas)) await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.end();
  }
});
