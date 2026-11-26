import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { connectionString, integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

// Pool.end can settle before its sockets finish disconnecting. The fixture
// must allow those connections to drain rather than terminate their owners.
integration("isolated fixture cleanup lets a disconnecting database connection finish", async () => {
  const fixture = await isolatedPostgres("fixture_drain", { migrate: false, runtimeRole: false });
  const late = new Client({ connectionString: fixture.url.toString() });
  const errors = [];
  late.on("error", error => errors.push(error.code));
  await late.connect();
  const disconnected = setTimeout(200).then(() => late.end());
  try {
    await fixture.close();
    await disconnected;
    assert.deepEqual(errors, [], "cleanup must not issue an administrator termination");
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      const remaining = await admin.query("SELECT datname FROM pg_database WHERE datname=$1",
        [fixture.url.pathname.slice(1)]);
      assert.equal(remaining.rowCount, 0);
    } finally { await admin.end(); }
  } finally { await disconnected; }
});

integration("isolated fixture cleanup fails on a leaked connection without killing it", async () => {
  const fixture = await isolatedPostgres("fixture_leak", { migrate: false, runtimeRole: false });
  const leaked = new Client({ connectionString: fixture.url.toString() });
  await leaked.connect();
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await assert.rejects(fixture.close(), /connections did not drain from fixture/);
    assert.equal((await leaked.query("SELECT 1 AS alive")).rows[0].alive, 1);
  } finally {
    await leaked.end();
    await admin.query(`DROP DATABASE ${fixture.url.pathname.slice(1)}`);
    await admin.end();
  }
});

integration("concurrent template-cloned isolated fixtures preserve empty shards and runtime role privileges", async () => {
  const fixtures = await Promise.all([
    isolatedPostgres("fixture_clone_a"),
    isolatedPostgres("fixture_clone_b"),
    isolatedPostgres("fixture_clone_c"),
  ]);
  try {
    for (const fixture of fixtures) {
      const migrations = await fixture.run("SELECT count(*)::int AS n FROM control.schema_migrations");
      assert.ok(migrations[0].n > 0, "cloned fixture must retain the migrated schema");
      const shards = await fixture.run("SELECT count(*)::int AS n FROM control.postgres_shards");
      assert.equal(shards[0].n, 0, "cloned fixture must start without pre-seeded shard rows");
      const privilege = await fixture.run(
        "SELECT has_table_privilege($1, 'control.schema_migrations', 'SELECT') AS allowed",
        [fixture.role],
      );
      assert.equal(privilege[0].allowed, true, "cloned fixture runtime role must inherit table privileges");
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
});
