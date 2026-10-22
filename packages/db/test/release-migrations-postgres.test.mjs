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
    const last = manifest.at(-1);
    assert.equal(last.id, "0213_expand_channel_replay_online_indexes");
    for (const migration of manifest.slice(0, -1)) {
      await applyMigration(client, migration, "fixture", role);
    }
    await client.query(`INSERT INTO control.postgres_shards
      (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ('shard-0','active','fixture',now(),now())`);
    await client.query(`INSERT INTO control.postgres_local_identity
      (singleton,shard_id,created_at) VALUES (true,'shard-0',now())`);
    await assert.rejects(invoke("shard-1"), /identity differs/u);
    // A foreign index under the requested name must never be adopted or removed.
    await client.query("CREATE INDEX scoped_replays_channel_purge_idx ON control.scoped_control_command_replays(scope_kind)");
    await assert.rejects(invoke(), /already owned/u);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM control.schema_migrations WHERE migration_id=$1",
      [last.id])).rows[0].n, 0);
    await client.query("DROP INDEX control.scoped_replays_channel_purge_idx");
    const results = await Promise.all([invoke(), invoke()]);
    assert.equal(results.flatMap(({ stdout }) => JSON.parse(stdout).applied).length, 1);
    const receipt = (await client.query(`SELECT app_revision,checksum_sha256 FROM control.schema_migrations
      WHERE migration_id=$1`, [last.id])).rows;
    assert.deepEqual(receipt, [{ app_revision: revision, checksum_sha256: last.checksumSha256 }]);
    assert.ok((await client.query("SELECT to_regclass('control.scoped_replays_channel_purge_idx') AS index"))
      .rows[0].index);
    assert.deepEqual(JSON.parse((await invoke()).stdout).applied, []);
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await isolated.close();
  }
});
