import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "pg";

import {
  CAPACITY_POLICY,
  AUTH_OBSERVATION_TABLES,
  OPERATIONAL_FACT_TABLES,
  assertOperationalSnapshot,
  assertRuntimeAccessSnapshot,
  capacityLevel,
  operationalOptions,
} from "../scripts/substrate.mjs";
import { checkedInMigrationRelations } from "../scripts/migration-relations.mjs";
import { connectionString, integration } from "./postgres-database.fixture.mjs";

const options = {
  shardId: "shard-0",
  fleetShardIds: ["shard-0"],
  capacityClass: "shared-single-node-v1",
};

const expected = await checkedInMigrationRelations();

// The production check compares the live schema with the replayed migrations,
// so the replay must read every relation DDL form the migrations use.
integration("the replayed migrations name exactly the relations a migrated database has", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const read = async (catalog) => (await client.query(`SELECT table_schema || '.' || table_name AS name
      FROM information_schema.${catalog} WHERE table_schema IN ('control', 'data')
      ${catalog === "tables" ? "AND table_type = 'BASE TABLE'" : ""}`)).rows.map(({ name }) => name).sort();
    assert.deepEqual(await read("tables"), [...expected.tables].sort());
    assert.deepEqual(await read("views"), [...expected.views].sort());
  } finally {
    await client.end();
  }
});

test("the substrate check rejects a schema that differs from the replayed migrations", () => {
  assert.ok(expected.tables.has("control.schema_migrations"));
  assert.throws(() => assertOperationalSnapshot(snapshot({ tables: [...expected.tables].slice(1) }), options, expected),
    /table inventory differs/u);
  assert.throws(() => assertOperationalSnapshot(snapshot({ views: ["data.stale_view"] }), options, expected),
    /view inventory differs/u);
});

function snapshot(overrides = {}) {
  return {
    tables: [...expected.tables],
    views: [...expected.views],
    pendingMigrations: [],
    shards: [{
      shard_id: options.shardId,
      state: "active",
      capacity_class: options.capacityClass,
    }],
    localShardId: options.shardId,
    factCounts: Object.fromEntries(OPERATIONAL_FACT_TABLES.map((name) => [name, "0"])),
    authCounts: Object.fromEntries(AUTH_OBSERVATION_TABLES.map((name) => [name, "0"])),
    ...overrides,
  };
}

test("operational schema accepts an explicit local shard identity and Auth target", () => {
  assert.doesNotThrow(() => assertOperationalSnapshot(snapshot(), options, expected));
  assert.doesNotThrow(() => assertOperationalSnapshot(snapshot({
    shards: [{ ...snapshot().shards[0], state: "draining" }],
  }), options, expected));
});

test("operational schema permits business facts and rejects invalid counts or routing drift", () => {
  assert.doesNotThrow(() => assertOperationalSnapshot(snapshot({
    factCounts: {
      ...snapshot().factCounts,
      space_placement: "2",
      user_space_locale_preferences: "4",
    },
  }), options, expected));
  assert.throws(() => assertOperationalSnapshot(snapshot({
    factCounts: { ...snapshot().factCounts, space_placement: "-1" },
  }), options, expected), /outside the supported integer range/u);
  assert.throws(
    () => assertOperationalSnapshot(snapshot({
      shards: [{ ...snapshot().shards[0], shard_id: "shard-1" }],
    }), options, expected),
    /physical shard metadata/u,
  );
});

test("capacity policy has ordered conservative levels", () => {
  const policy = CAPACITY_POLICY.postgresLogical;
  assert.equal(capacityLevel(policy.warningBytes - 1), "healthy");
  assert.equal(capacityLevel(policy.warningBytes), "warning");
  assert.equal(capacityLevel(policy.criticalBytes), "critical");
  assert.equal(capacityLevel(policy.emergencyBytes), "emergency");
});

test("physical shard labels are explicit and bounded", () => {
  assert.deepEqual(operationalOptions({
    POSTGRES_SHARD_ID: "shard-0",
    POSTGRES_CAPACITY_CLASS: "shared-single-node-v1",
  }), options, expected);
  assert.throws(() => operationalOptions({
    POSTGRES_SHARD_ID: "shard 0",
    POSTGRES_CAPACITY_CLASS: "shared-single-node-v1",
  }), /POSTGRES_SHARD_ID is invalid/u);
  assert.deepEqual(operationalOptions({
    POSTGRES_SHARD_ID: "shard-0",
    POSTGRES_FLEET_SHARD_IDS: "shard-1,shard-0",
    POSTGRES_CAPACITY_CLASS: "shared-single-node-v1",
  }), {
    ...options,
    fleetShardIds: ["shard-0", "shard-1"],
  });
  assert.throws(() => operationalOptions({
    POSTGRES_SHARD_ID: "shard-0",
    POSTGRES_FLEET_SHARD_IDS: "shard-1",
    POSTGRES_CAPACITY_CLASS: "shared-single-node-v1",
  }), /must be unique and include/u);
});

test("runtime access verification fails closed on a missing role or denied relation", () => {
  assert.doesNotThrow(() => assertRuntimeAccessSnapshot({
    runtimeRole: "xmatrix_next_runtime", roleExists: true,
    checkedRelations: 111, deniedRelations: [], checkedSequences: 1,
    deniedSequences: [], deniedSchemas: [],
  }));
  assert.throws(() => assertRuntimeAccessSnapshot({
    runtimeRole: "xmatrix_next_runtime", roleExists: false,
    checkedRelations: 0, deniedRelations: [], checkedSequences: 0,
    deniedSequences: [], deniedSchemas: [],
  }), /role is unavailable/u);
  assert.throws(() => assertRuntimeAccessSnapshot({
    runtimeRole: "xmatrix_next_shard_1_runtime", roleExists: true,
    checkedRelations: 111, deniedRelations: ["data.agent_launches"], checkedSequences: 1,
    deniedSequences: [], deniedSchemas: [],
  }), /lacks access/u);
  assert.throws(() => assertRuntimeAccessSnapshot({
    runtimeRole: "xmatrix_next_shard_1_runtime", roleExists: true,
    checkedRelations: 111, deniedRelations: [], checkedSequences: 1,
    deniedSequences: ["data.search_rank_sequence_v1"], deniedSchemas: [],
  }), /lacks access/u);
});
