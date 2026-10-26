import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertExpandOnlyPostgresMigration,
  assertPostgresRuntimeRole,
  assertExistingExpandTarget,
  loadMigrationManifest,
  parseMigrationArgs,
  reconcileMigrationState,
} from "../scripts/migrate.mjs";

test("existing release migration mode cannot bootstrap or authorize contract work", async () => {
  const revision = "a".repeat(40);
  assert.equal(parseMigrationArgs(["apply", "--existing-expand-only", `--revision=${revision}`])
    .existingExpandOnly, true);
  for (const args of [
    ["apply", "--revision=local"], ["check", `--revision=${revision}`],
    ["apply", `--revision=${revision}`, "--allow-contract"],
  ]) assert.throws(() => parseMigrationArgs([...args, "--existing-expand-only"]), /Existing expand/u);

  const checkedIn = await loadMigrationManifest();
  // The release path only ever sees a ledger whose pending tail is expand work;
  // exercise it against the expand prefix before the first contract migration.
  const firstContract = checkedIn.findIndex(({ phase }) => phase === "contract");
  const manifest = firstContract < 0 ? checkedIn : checkedIn.slice(0, firstContract);
  const rows = manifest.slice(0, -1).map((m) => ({
    migration_id: m.id, checksum_sha256: m.checksumSha256, phase: m.phase,
  }));
  let reads = 0;
  const client = { query: async () => { reads += 1; return { rows: [{ shard_id: "shard-0" }] }; } };
  assert.deepEqual((await assertExistingExpandTarget(client, manifest, rows, "shard-0"))
    .map(({ id }) => id), [manifest.at(-1).id]);
  assert.equal(reads, 1);
  // A checked-in contract migration left pending is never applied by the release path.
  const expandApplied = manifest.map((m) => ({
    migration_id: m.id, checksum_sha256: m.checksumSha256, phase: m.phase,
  }));
  await assert.rejects(assertExistingExpandTarget(client, checkedIn, expandApplied, "shard-0"),
    /pending contract migration/u);
  await assert.rejects(assertExistingExpandTarget(client, manifest, [], "shard-0"), /empty ledger/u);
  await assert.rejects(assertExistingExpandTarget(client,
    [...manifest.slice(0, -1), { ...manifest.at(-1), phase: "contract" }], rows, "shard-0"), /contract/u);
  await assert.rejects(assertExistingExpandTarget(client, manifest, rows, "shard-1"), /identity differs/u);
  await assert.rejects(assertExistingExpandTarget(client, manifest, rows, undefined), /POSTGRES_SHARD_ID/u);
  await assert.rejects(assertExistingExpandTarget(client, manifest,
    [{ ...rows[0], checksum_sha256: "0".repeat(64) }, ...rows.slice(1)], "shard-0"), /checksum changed/u);
});

test("runtime role for migration apply is explicit and safe to interpolate", () => {
  assert.equal(assertPostgresRuntimeRole("xmatrix_next_runtime"), "xmatrix_next_runtime");
  for (const role of [undefined, "", "xmatrix-next-runtime", "XmatrixRuntime", "0runtime"]) {
    assert.throws(() => assertPostgresRuntimeRole(role), /POSTGRES_RUNTIME_ROLE/u);
  }
});

test("migration loading preserves source checksums and classifies contract work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmatrix-db-manifest-"));
  await writeFile(join(directory, "0000_expand_initial.sql"), "CREATE TABLE data.fixture (id TEXT);\n");
  await writeFile(join(directory, "0001_contract_retire.sql"), "DROP TABLE data.fixture;\n");
  const manifest = await loadMigrationManifest(directory);
  assert.deepEqual(manifest.map(({ id, phase, checksumSha256 }) => ({ id, phase, checksumSha256 })), [
    { id: "0000_expand_initial", phase: "expand", checksumSha256: "3ff646d239ac70075553fefe8dcb68fd997f7a36a9f395d3b162fae7efc2af66" },
    { id: "0001_contract_retire", phase: "contract", checksumSha256: "3c4298892122cf816f7ffe38e582501651e702625dac0969d1126ffc98e26fcd" },
  ]);
});

test("expand policy rejects destructive and rewriting PostgreSQL migrations", () => {
  for (const sql of [
    "DROP TABLE data.messages;",
    "ALTER TABLE data.messages DROP COLUMN body;",
    "ALTER TABLE data.messages ADD COLUMN body text NOT NULL;",
    "UPDATE data.messages SET body = '';",
    "CREATE OR REPLACE VIEW data.messages_view AS SELECT 1;",
    "ALTER TABLE data.messages ALTER COLUMN body SET NOT NULL;",
    "ALTER TABLE data.messages ALTER COLUMN body TYPE bigint;",
    "ALTER TABLE data.messages ALTER COLUMN body DROP NOT NULL, DROP COLUMN other;",
  ]) {
    assert.throws(() => assertExpandOnlyPostgresMigration(sql), /not expand-only/u);
  }
  assert.doesNotThrow(() => assertExpandOnlyPostgresMigration(
    "ALTER TABLE data.messages ADD COLUMN body text;",
  ));
  // Relaxing NOT NULL widens the column; running code keeps writing values.
  assert.doesNotThrow(() => assertExpandOnlyPostgresMigration(
    "ALTER TABLE data.runs ALTER COLUMN agent_profile_id DROP NOT NULL;",
  ));
});

test("manifest rejects gaps and invalid filenames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmatrix-db-migrations-"));
  await writeFile(join(directory, "0001_expand_gap.sql"), "CREATE TABLE gap (id text);\n");
  await assert.rejects(loadMigrationManifest(directory), /contiguous from 0000/u);
});

test("ledger reconciliation rejects edited history and applied gaps", async () => {
  const manifest = await loadMigrationManifest();
  assert.throws(
    () => reconcileMigrationState(manifest, [{
      migration_id: manifest[0].id,
      checksum_sha256: "0".repeat(64),
      phase: "expand",
    }]),
    /checksum changed/u,
  );
  assert.throws(
    () => reconcileMigrationState(manifest, [{
      migration_id: manifest[1].id,
      checksum_sha256: manifest[1].checksumSha256,
      phase: manifest[1].phase,
    }]),
    /ledger has a gap/u,
  );
});

test("expand triggers guard only newly created history tables and cannot hide mutations", () => {
  const trigger = "CREATE TRIGGER immutable BEFORE UPDATE ON data.history FOR EACH ROW EXECUTE FUNCTION data.guard();";
  assert.doesNotThrow(() => assertExpandOnlyPostgresMigration("CREATE TABLE data.history (id TEXT); " + trigger));
  assert.throws(() => assertExpandOnlyPostgresMigration(trigger), /not expand-only/);
  assert.throws(() => assertExpandOnlyPostgresMigration("CREATE TABLE data.history (id TEXT); " + trigger + " UPDATE data.old SET id='x';"), /not expand-only/);
});
