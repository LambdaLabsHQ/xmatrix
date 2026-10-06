import { convergeRuntimeAccess, loadMigrationManifest } from "../scripts/migrate.mjs";

// Applies the checked-in manifest up to and including `lastId`, recording each
// migration in the ledger exactly as the migrator does, so the migrator CLI can
// later apply the remaining ones on top. Lets a test stop between two
// migrations (for example to seed rows only an older Hub could have written).
export async function applyMigrationsThrough(client, lastId, runtimeRole) {
  const manifest = await loadMigrationManifest();
  const end = manifest.findIndex(({ id }) => id === lastId);
  if (end < 0) throw new Error(`unknown migration ${lastId}`);
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('xmatrix.runtime_role',$1,true)", [runtimeRole]);
    for (const migration of manifest.slice(0, end + 1)) {
      await client.query(migration.source);
      await client.query(`INSERT INTO control.schema_migrations
        (migration_id,checksum_sha256,phase,app_revision,execution_ms) VALUES ($1,$2,$3,'fixture',0)`,
      [migration.id, migration.checksumSha256, migration.phase]);
    }
    const runtimeAccess = await convergeRuntimeAccess(client, runtimeRole);
    await client.query("COMMIT");
    return { applied: manifest.slice(0, end + 1).map(({ id }) => id), runtimeAccess };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
