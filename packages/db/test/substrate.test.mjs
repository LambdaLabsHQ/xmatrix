import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPACITY_POLICY,
  AUTH_OBSERVATION_TABLES,
  OPERATIONAL_FACT_TABLES,
  EXPECTED_SUBSTRATE_TABLES,
  EXPECTED_SUBSTRATE_VIEWS,
  assertOperationalSnapshot,
  assertRuntimeAccessSnapshot,
  capacityLevel,
  operationalOptions,
} from "../scripts/substrate.mjs";
import { checkedInMigrationRelations } from "./migration-relations.mjs";

const options = {
  shardId: "shard-0",
  fleetShardIds: ["shard-0"],
  capacityClass: "shared-single-node-v1",
};

test("substrate inventory contains every table and view the checked-in migrations leave", async () => {
  const { tables, views } = await checkedInMigrationRelations();
  assert.deepEqual([...tables].sort(), EXPECTED_SUBSTRATE_TABLES);
  assert.deepEqual([...views].sort(), EXPECTED_SUBSTRATE_VIEWS);
});

function snapshot(overrides = {}) {
  return {
    tables: EXPECTED_SUBSTRATE_TABLES,
    views: EXPECTED_SUBSTRATE_VIEWS,
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
  assert.doesNotThrow(() => assertOperationalSnapshot(snapshot(), options));
  assert.doesNotThrow(() => assertOperationalSnapshot(snapshot({
    shards: [{ ...snapshot().shards[0], state: "draining" }],
  }), options));
});

test("operational schema permits business facts and rejects invalid counts or routing drift", () => {
  assert.doesNotThrow(() => assertOperationalSnapshot(snapshot({
    factCounts: {
      ...snapshot().factCounts,
      space_placement: "2",
      user_space_locale_preferences: "4",
    },
  }), options));
  assert.throws(() => assertOperationalSnapshot(snapshot({
    factCounts: { ...snapshot().factCounts, space_placement: "-1" },
  }), options), /outside the supported integer range/u);
  assert.throws(
    () => assertOperationalSnapshot(snapshot({
      shards: [{ ...snapshot().shards[0], shard_id: "shard-1" }],
    }), options),
    /physical shard metadata/u,
  );
});

test("operational schema permits Auth shadow facts", () => {
  assert.doesNotThrow(() => assertOperationalSnapshot(snapshot({
    authCounts: { ...snapshot().authCounts, auth_users: "12", auth_shadow_runs: "1" },
  }), options));
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
  }), options);
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
