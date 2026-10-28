import { isolatedPostgres } from "./postgres-database.fixture.mjs";
import { integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyMigration, loadMigrationManifest } from "../scripts/migrate.mjs";

const execute = promisify(execFile);

integration("release expand migrations refuse unowned indexes and resume once on the same ledger", async () => {
  const isolated = await isolatedPostgres("release_migration", { migrate: false });
  const { client, role, url } = isolated;
  // Keep the CLI's real package layout and module resolution, but make this
  // interruption scenario independent of whichever migration was last shipped.
  const fixtureRoot = await realpath(await mkdtemp(new URL("../node_modules/.release-migration-", import.meta.url)));
  try {
    await cp(new URL("../scripts", import.meta.url), join(fixtureRoot, "scripts"), { recursive: true });
    await cp(new URL("../migrations", import.meta.url), join(fixtureRoot, "migrations"), { recursive: true });
    const baseline = await loadMigrationManifest();
    const next = baseline.length.toString().padStart(4, "0");
    await writeFile(join(fixtureRoot, "migrations", `${next}_expand_release_resume_fixture.sql`),
      "-- xmatrix:online-indexes\nCREATE INDEX CONCURRENTLY release_resume_fixture_idx ON data.messages (sent_at);\n");
    const following = (baseline.length + 1).toString().padStart(4, "0");
    await writeFile(join(fixtureRoot, "migrations", `${following}_expand_release_following_fixture.sql`),
      "CREATE TABLE data.release_following_fixture (id TEXT PRIMARY KEY);\n");
    const revision = "b".repeat(40);
    const invoke = (shard = "shard-0") => execute(process.execPath,
      [join(fixtureRoot, "scripts", "migrate.mjs"),
        "apply", "--existing-expand-only", `--revision=${revision}`], {
        timeout: 35_000,
        env: { ...process.env, DATABASE_URL: url.toString(),
          POSTGRES_RUNTIME_ROLE: role, POSTGRES_SHARD_ID: shard },
      });
    await assert.rejects(invoke(), /empty ledger/u);
    assert.equal((await client.query("SELECT to_regclass('control.schema_migrations') AS ledger"))
      .rows[0].ledger, null, "release does not bootstrap an empty database");

    const manifest = await loadMigrationManifest(join(fixtureRoot, "migrations"));
    const last = manifest[baseline.length];
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
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
