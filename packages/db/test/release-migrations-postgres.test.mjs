import { isolatedPostgres } from "./postgres-database.fixture.mjs";
import { integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadMigrationManifest } from "../scripts/migrate.mjs";

const execute = promisify(execFile);

integration("release expand migrations roll back failed DDL and resume once on the same ledger", async () => {
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
    assert.equal(last.id, "0042_expand_message_append_hot_path");
    await client.query("BEGIN");
    await client.query("SELECT set_config('xmatrix.runtime_role',$1,true)", [role]);
    for (const migration of manifest.slice(0, -1)) {
      await client.query(migration.source);
      await client.query(`INSERT INTO control.schema_migrations
        (migration_id,checksum_sha256,phase,app_revision,execution_ms) VALUES ($1,$2,$3,'fixture',0)`,
      [migration.id, migration.checksumSha256, migration.phase]);
    }
    await client.query(`INSERT INTO control.postgres_shards
      (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ('shard-0','active','fixture',now(),now())`);
    await client.query(`INSERT INTO control.postgres_local_identity
      (singleton,shard_id,created_at) VALUES (true,'shard-0',now())`);
    await client.query("COMMIT");
    await assert.rejects(invoke("shard-1"), /identity differs/u);
    // Make the exact checked-in DDL fail. The migrator must not write its ledger row.
    await client.query(last.source);
    await assert.rejects(invoke(), /already exists/u);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM control.schema_migrations WHERE migration_id=$1",
      [last.id])).rows[0].n, 0);
    await client.query("DROP INDEX data.space_members_billable_seat_idx");
    const results = await Promise.all([invoke(), invoke()]);
    assert.equal(results.flatMap(({ stdout }) => JSON.parse(stdout).applied).length, 1);
    const receipt = (await client.query(`SELECT app_revision,checksum_sha256 FROM control.schema_migrations
      WHERE migration_id=$1`, [last.id])).rows;
    assert.deepEqual(receipt, [{ app_revision: revision, checksum_sha256: last.checksumSha256 }]);
    assert.ok((await client.query("SELECT to_regclass('data.space_members_billable_seat_idx') AS index"))
      .rows[0].index);
    assert.deepEqual(JSON.parse((await invoke()).stdout).applied, []);
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await isolated.close();
  }
});
