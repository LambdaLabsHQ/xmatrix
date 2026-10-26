import { isolatedPostgres } from "./postgres-database.fixture.mjs";
import { integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyMigration, loadMigrationManifest } from "../scripts/migrate.mjs";

const execute = promisify(execFile);

integration("release expand migrations refuse unowned indexes and resume once on the same ledger", async () => {
  const isolated = await isolatedPostgres("release_migration", { migrate: false });
  const { client, role, url } = isolated;
  try {
    const revision = "b".repeat(40);
    const invoke = (shard = "shard-0") => execute(process.execPath,
      [new URL("../scripts/migrate.mjs", import.meta.url).pathname,
        "apply", "--existing-expand-only", `--revision=${revision}`], {
        timeout: 35_000,
        env: { ...process.env, DATABASE_URL: url.toString(),
          POSTGRES_RUNTIME_ROLE: role, POSTGRES_SHARD_ID: shard },
      });
    await assert.rejects(invoke(), /empty ledger/u);
    assert.equal((await client.query("SELECT to_regclass('control.schema_migrations') AS ledger"))
      .rows[0].ledger, null, "release does not bootstrap an empty database");

    const manifest = await loadMigrationManifest();
    // Anchor the interrupted online build at the first one a release can still
    // apply: release refuses a pending contract, so it follows the last one.
    // Subsequent expand migrations are part of the same release and must also
    // apply exactly once.
    const lastContract = manifest.findLastIndex(migration => migration.phase !== "expand");
    const last = manifest.slice(lastContract + 1).find(migration => migration.onlineIndexes);
    assert.ok(last, "an online index migration follows the last contract migration");
    const [index] = last.onlineIndexes;
    const indexName = `${index.schema}.${index.name}`;
    const pending = manifest.slice(manifest.indexOf(last));
    for (const migration of manifest.slice(0, manifest.indexOf(last))) {
      await applyMigration(client, migration, "fixture", role);
    }
    await client.query(`INSERT INTO control.postgres_shards
      (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ('shard-0','active','fixture',now(),now())`);
    await client.query(`INSERT INTO control.postgres_local_identity
      (singleton,shard_id,created_at) VALUES (true,'shard-0',now())`);
    await assert.rejects(invoke("shard-1"), /identity differs/u);
    // A foreign index under the requested name must never be adopted or removed.
    const [column] = (await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position LIMIT 1`, [index.schema, index.table])).rows;
    await client.query(`CREATE INDEX ${index.name} ON ${index.schema}.${index.table}(${column.column_name})`);
    await assert.rejects(invoke(), /already owned/u);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM control.schema_migrations WHERE migration_id=$1",
      [last.id])).rows[0].n, 0);
    await client.query(`DROP INDEX ${indexName}`);
    const results = await Promise.all([invoke(), invoke()]);
    assert.equal(results.flatMap(({ stdout }) => JSON.parse(stdout).applied).length, pending.length);
    const receipt = (await client.query(`SELECT app_revision,checksum_sha256 FROM control.schema_migrations
      WHERE migration_id=$1`, [last.id])).rows;
    assert.deepEqual(receipt, [{ app_revision: revision, checksum_sha256: last.checksumSha256 }]);
    assert.ok((await client.query("SELECT to_regclass($1) AS index", [indexName]))
      .rows[0].index);
    assert.deepEqual(JSON.parse((await invoke()).stdout).applied, []);
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await isolated.close();
  }
});
