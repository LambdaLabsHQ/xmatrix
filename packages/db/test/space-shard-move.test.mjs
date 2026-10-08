import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKING_SPACE_TABLES,
  GLOBAL_DATA_TABLES,
  INDIRECT_MOVABLE_SPACE_TABLES,
  MOVABLE_SPACE_TABLES,
  blockingSpaceTables,
  canonicalRow,
  digestTableRows,
  nextSyncPhase,
  nextVerifyPhase,
  preflightMovement,
} from "../scripts/space-shard-move.mjs";
import { checkedInMigrationRelations } from "../scripts/migration-relations.mjs";

test("blocking Space inspection is read-only and returns every present authority domain", async () => {
  const queried = [];
  const present = new Set(["runs", "workspaces", "app_teams_link_attempts", "app_teams_room_bindings"]);
  const client = {
    async query(text, values) {
      assert.deepEqual(values, ["space-1"]);
      const table = /FROM data\."([a-z0-9_]+)"/u.exec(text)?.[1];
      queried.push(table);
      return { rows: [{ present: present.has(table) }] };
    },
  };
  assert.deepEqual(await blockingSpaceTables(client, "space-1"), ["app_teams_link_attempts", "app_teams_room_bindings", "runs", "workspaces"]);
  assert.equal(queried.includes("app_teams_room_lifecycle"), false);
  assert.deepEqual(queried, BLOCKING_SPACE_TABLES);
});

test("movement preflight rejects an active movement without touching either physical shard", async () => {
  const directoryCalls = [];
  const directory = {
    async query(text) {
      directoryCalls.push(text);
      if (text.includes("FROM control.space_placement")) {
        return {
          rowCount: 1,
          rows: [{
            space_id: "space-1",
            shard_id: "shard-0",
            placement_epoch: "4",
            state: "active",
            target_shard_id: null,
          }],
        };
      }
      if (text.includes("FROM control.space_shard_movements")) {
        return { rowCount: 1, rows: [{ movement_id: "move-active", phase: "copying" }] };
      }
      throw new Error(`unexpected directory query: ${text}`);
    },
  };
  const untouched = { async query() { throw new Error("physical shard was touched"); } };
  await assert.rejects(
    preflightMovement(directory, untouched, untouched, {
      space: "space-1",
      target: "shard-1",
    }, { limits: { rows: 100, bytes: 1_000 } }),
    /already has active movement move-active/u,
  );
  assert.equal(directoryCalls.some((text) => /\b(?:INSERT|UPDATE|DELETE)\b/iu.test(text)), false);
});

test("every PostgreSQL data table has exactly one shard movement classification", async () => {
  const schemaTables = new Set([...(await checkedInMigrationRelations()).tables]
    .filter((table) => table.startsWith("data.")).map((table) => table.slice("data.".length)));
  const classifications = [
    ...MOVABLE_SPACE_TABLES,
    ...INDIRECT_MOVABLE_SPACE_TABLES,
    ...BLOCKING_SPACE_TABLES,
    ...GLOBAL_DATA_TABLES,
  ];
  assert.equal(new Set(classifications).size, classifications.length, "classification sets overlap");
  assert.deepEqual([...new Set(classifications)].sort(), [...schemaTables].sort());
});

test("canonical shard digest is stable across object key order and PostgreSQL value types", () => {
  const first = {
    payload_json: { z: 2, a: [1, { y: true, x: null }] },
    encoded: Buffer.from("hello"),
    at: new Date("2026-08-30T00:00:00.000Z"),
    count: 42n,
  };
  const second = {
    count: 42n,
    at: new Date("2026-08-30T00:00:00.000Z"),
    encoded: new Uint8Array(Buffer.from("hello")),
    payload_json: { a: [1, { x: null, y: true }], z: 2 },
  };
  assert.equal(canonicalRow(first), canonicalRow(second));
  assert.deepEqual(
    digestTableRows([{ name: "facts", rows: [first] }]),
    digestTableRows([{ name: "facts", rows: [second] }]),
  );
});

test("movement phase helpers enforce snapshot, catch-up, and final-copy order", () => {
  assert.equal(nextSyncPhase("copying"), "catching_up");
  assert.equal(nextSyncPhase("catching_up"), "caught_up");
  assert.equal(nextSyncPhase("caught_up"), "caught_up");
  assert.equal(nextSyncPhase("frozen"), "final_copied");
  assert.equal(nextVerifyPhase("caught_up"), "verified");
  assert.equal(nextVerifyPhase("final_copied"), "final_verified");
  assert.throws(() => nextSyncPhase("verified"), /cannot be synchronized/u);
  assert.throws(() => nextVerifyPhase("frozen"), /cannot be verified/u);
});
