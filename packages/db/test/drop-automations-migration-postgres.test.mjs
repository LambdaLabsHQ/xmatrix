import assert from "node:assert/strict";
import { applyMigration, loadMigrationManifest } from "../scripts/migrate.mjs";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

const MIGRATION = "0253_contract_drop_automations";

// The schema just before 0253, holding the given Automations, then 0253.
async function beforeDrop(automations, body) {
  const isolated = await isolatedPostgres("drop_automations", { migrate: false });
  const { client, role } = isolated;
  try {
    const manifest = await loadMigrationManifest();
    const target = manifest.find(({ id }) => id === MIGRATION);
    assert.ok(target);
    for (const migration of manifest.slice(0, manifest.indexOf(target))) {
      await applyMigration(client, migration, "fixture", role);
    }
    for (const [id, enabled, detached] of automations) {
      await client.query(`INSERT INTO data.automations (automation_id,owner_user_id,channel_id,next_run_at,enabled,
          version,payload_json,page_id,detached_at,created_at,updated_at)
        VALUES ($1,'owner','channel',now(),$2,1,'{}','page',$3,now(),now())`,
      [id, enabled, detached ? new Date() : null]);
      await client.query(`INSERT INTO data.automation_occurrences (occurrence_id,automation_id,automation_version,
          owner_user_id,scheduled_for,status,attempts,next_attempt_at,control_id,created_at,updated_at,finished_at)
        VALUES ($1,$2,1,'owner',now(),'dispatched',1,now(),$1,now(),now(),now())`, [`${id}:occurrence`, id]);
    }
    await body({ client, apply: () => applyMigration(client, target, "fixture", role) });
  } finally {
    await isolated.close();
  }
}

const relations = async (client) => (await client.query(`SELECT to_regclass('data.automations') AS automations,
  to_regclass('data.automation_occurrences') AS occurrences, to_regclass('data.automation_occurrence_runs') AS runs,
  to_regprocedure('data.automation_occurrence_conversation_id(text)') AS conversation`)).rows[0];

integration("0253 refuses while an Automation would still run, and changes nothing", async () => {
  await beforeDrop([["paused", false, false], ["running", true, false]], async ({ client, apply }) => {
    await assert.rejects(apply(), (error) => error.code === "55006" && /1 Automation\(s\) are still enabled/u.test(error.message));
    assert.equal((await client.query("SELECT count(*)::int AS n FROM data.automations")).rows[0].n, 2);
    assert.ok(Object.values(await relations(client)).every(Boolean), "every relation remains");
    assert.equal((await client.query("SELECT count(*)::int AS n FROM control.schema_migrations WHERE migration_id=$1",
      [MIGRATION])).rows[0].n, 0, "the refusal records no migration");
  });
});

integration("0253 drops the Automation storage when no Automation would run", async () => {
  // Paused, and enabled but detached from its page: neither runs.
  await beforeDrop([["paused", false, false], ["detached", true, true]], async ({ client, apply }) => {
    assert.equal(await apply(), true);
    assert.deepEqual(await relations(client), { automations: null, occurrences: null, runs: null, conversation: null });
    assert.equal((await client.query("SELECT count(*)::int AS n FROM control.schema_migrations WHERE migration_id=$1",
      [MIGRATION])).rows[0].n, 1);
  });
});
