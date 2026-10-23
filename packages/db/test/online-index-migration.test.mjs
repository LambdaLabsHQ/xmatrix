import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { Client } from "pg";
import { applyMigration } from "../scripts/migrate.mjs";
import { onlineIndexStatements } from "../scripts/online-index-migration.mjs";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

async function migration(sql, id = "9999_expand_online_test") {
  const source = `-- xmatrix:online-indexes\n${sql}`;
  return { id, phase: "expand", source,
    checksumSha256: createHash("sha256").update(source).digest("hex"),
    onlineIndexes: await onlineIndexStatements(source, "expand") };
}

test("online migration mode rejects transactional, destructive, ambiguous and contract statements", async () => {
  for (const sql of ["DELETE FROM data.outbox", "CREATE INDEX plain ON data.outbox(outbox_id)",
    "CREATE UNIQUE INDEX CONCURRENTLY unique_idx ON data.outbox(outbox_id)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS exists_idx ON data.outbox(outbox_id)",
    "CREATE INDEX CONCURRENTLY unscoped ON outbox(outbox_id)",
    "CREATE INDEX CONCURRENTLY valid ON data.outbox(outbox_id); SELECT 1",
    "CREATE INDEX CONCURRENTLY repeated ON data.outbox(outbox_id); CREATE INDEX CONCURRENTLY repeated ON data.outbox(topic)"]) {
    await assert.rejects(migration(sql), /Online migrations allow only/u);
  }
  await assert.rejects(onlineIndexStatements("CREATE INDEX CONCURRENTLY bad ON data.outbox(outbox_id)", "expand"), /require online-indexes/u);
  await assert.rejects(onlineIndexStatements("-- xmatrix:online-indexes\nCREATE INDEX CONCURRENTLY bad ON data.outbox(outbox_id)", "contract"), /expand migration/u);
  const parsed = await migration("-- 多字节注释、字符串内分号均不能切断语句\nCREATE INDEX CONCURRENTLY first ON data.outbox((payload_json->>'a;b'));\nCREATE INDEX CONCURRENTLY second ON data.outbox(topic);");
  assert.equal(parsed.onlineIndexes.length, 2);
  assert.match(parsed.onlineIndexes[0].text, /'a;b'/u);
  assert.match(parsed.onlineIndexes[1].text, /^\s*CREATE INDEX CONCURRENTLY second/u);
});

// The owning migrator/real-PG boundary proves internal CREATE commits do not
// publish a migration receipt, block writers, or prevent bounded recovery.
integration("cancelled online builds preserve intent, recover their invalid index and commit once", async () => {
  const f = await isolatedPostgres("online_index");
  const builder = new Client({ connectionString: f.url.toString() });
  const blocker = new Client({ connectionString: f.url.toString() });
  const peer = new Client({ connectionString: f.url.toString() });
  let work;
  try {
    await builder.connect(); await blocker.connect(); await peer.connect();
    await f.run("CREATE TABLE data.online_index_target(id int,body text)");
    await blocker.query("BEGIN");
    await blocker.query("INSERT INTO data.online_index_target VALUES(1,'older writer')");
    const plan = await migration("CREATE INDEX CONCURRENTLY online_test_idx ON data.online_index_target(id)");
    const pid = (await builder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    // Observe rejection immediately so cancelling cannot cause an unhandled rejection.
    work = applyMigration(builder, plan, "local", f.role).then(value => ({ value }), error => ({ error }));
    const deadline = Date.now() + 5000;
    while (!(await f.run("SELECT 1 FROM pg_stat_progress_create_index WHERE pid=$1 AND phase='waiting for writers before build'", [pid])).length) {
      assert.ok(Date.now() < deadline, "the real concurrent build must reach its writer wait");
      await setTimeout(10);
    }
    await f.run("SET statement_timeout='500ms'");
    await f.run("INSERT INTO data.online_index_target VALUES(2,'concurrent writer')");
    await f.run("SET statement_timeout='5s'");
    assert.equal((await f.run("SELECT count(*)::int AS n FROM control.schema_migrations WHERE migration_id=$1", [plan.id]))[0].n, 0);
    await f.run("SELECT pg_cancel_backend($1)", [pid]);
    assert.equal((await work).error?.code, "57014");
    await blocker.query("ROLLBACK");
    assert.deepEqual(await f.run("SELECT indisvalid FROM pg_index WHERE indexrelid='data.online_test_idx'::regclass"), [{ indisvalid: false }]);
    assert.equal((await f.run("SELECT count(*)::int AS n FROM control.schema_migration_index_builds WHERE migration_id=$1", [plan.id]))[0].n, 1);
    assert.deepEqual((await Promise.all([applyMigration(builder, plan, "local", f.role),
      applyMigration(peer, plan, "local", f.role)])).sort(), [false, true]);
    assert.equal(await applyMigration(builder, plan, "local", f.role), false);
    assert.deepEqual(await f.run("SELECT indisvalid,indisready FROM pg_index WHERE indexrelid='data.online_test_idx'::regclass"), [{ indisvalid: true, indisready: true }]);
    assert.equal((await f.run("SELECT count(*)::int AS n FROM control.schema_migrations WHERE migration_id=$1", [plan.id]))[0].n, 1);
    await assert.rejects(applyMigration(builder, { ...plan, checksumSha256: "0".repeat(64) }, "local", f.role), /checksum conflict/u);

    // Crash states after CREATE/marker but before the final ledger commit.
    const indexOid = (await f.run("SELECT 'data.online_test_idx'::regclass::oid AS oid"))[0].oid;
    await f.run("DELETE FROM control.schema_migrations WHERE migration_id=$1", [plan.id]);
    assert.equal(await applyMigration(builder, plan, "local", f.role), true);
    assert.equal((await f.run("SELECT 'data.online_test_idx'::regclass::oid AS oid"))[0].oid, indexOid,
      "an exact marked index is reused after a missing receipt");
    await f.run("DELETE FROM control.schema_migrations WHERE migration_id=$1", [plan.id]);
    await f.run("UPDATE control.schema_migration_index_builds SET checksum_sha256=repeat('0',64) WHERE migration_id=$1", [plan.id]);
    await assert.rejects(applyMigration(builder, plan, "local", f.role), /intent differs/u);
    await f.run("UPDATE control.schema_migration_index_builds SET checksum_sha256=$2 WHERE migration_id=$1", [plan.id, plan.checksumSha256]);
    await f.run("COMMENT ON INDEX data.online_test_idx IS NULL");
    assert.equal(await applyMigration(builder, plan, "local", f.role), true);
    assert.notEqual((await f.run("SELECT 'data.online_test_idx'::regclass::oid AS oid"))[0].oid, indexOid,
      "an unmarked owned index is rebuilt rather than adopting an unknown definition");

    await f.run("CREATE INDEX foreign_idx ON data.online_index_target(body)");
    const foreign = await migration("CREATE INDEX CONCURRENTLY foreign_idx ON data.online_index_target(id)", "9998_expand_foreign_test");
    await assert.rejects(applyMigration(builder, foreign, "local", f.role), /already owned/u);
    assert.ok((await f.run("SELECT pg_get_indexdef('data.foreign_idx'::regclass) AS definition"))[0].definition.includes("(body)"));
    assert.equal((await f.run("SELECT count(*)::int AS n FROM control.schema_migration_index_builds WHERE index_name='foreign_idx'"))[0].n, 0);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await work;
    await builder.end(); await blocker.end(); await peer.end(); await f.close();
  }
});
