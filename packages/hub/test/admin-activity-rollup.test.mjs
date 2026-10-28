import assert from "node:assert/strict";
import test from "node:test";

import {
  rollUpAdminActivity,
  rollUpAdminActivityOnSchedule,
} from "../src/postgres-admin-activity-rollup.ts";
import { adminQueryDatabase } from "./support/admin-query-database.mjs";

const NOW = Date.parse("2026-10-27T23:41:00.000Z");

function database(state, seen = []) {
  return adminQueryDatabase({
    admin_activity_rollup_state_lock_v1: state,
    admin_activity_rollup_clear_first_v1: [],
    admin_activity_rollup_settle_first_v1: [],
    admin_activity_rollup_clear_next_v1: [],
    admin_activity_rollup_settle_next_v1: [],
    admin_activity_rollup_advance_v1: [],
  }, (query) => seen.push(query));
}

test("a roll-up already running elsewhere is left to finish", async () => {
  const seen = [];
  assert.deepEqual(await rollUpAdminActivity(database([], seen), { requestId: "r", now: NOW }), { status: "busy" });
  assert.deepEqual(seen.map((query) => query.name), ["admin_activity_rollup_state_lock_v1"]);
  assert.match(seen[0].text, /FOR UPDATE SKIP LOCKED/u);
});

test("a shard settled through the day before yesterday has nothing to do", async () => {
  const seen = [];
  assert.deepEqual(await rollUpAdminActivity(database([{ settled_through: "2026-10-25" }], seen),
    { requestId: "r", now: NOW }), { status: "current" });
  assert.equal(seen.length, 1);
});

test("the first roll-up settles every day before the day before yesterday", async () => {
  const seen = [];
  assert.deepEqual(await rollUpAdminActivity(database([{ settled_through: null }], seen), { requestId: "r", now: NOW }),
    { status: "settled", from: null, through: "2026-10-25" });
  assert.deepEqual(seen.map((query) => query.name), [
    "admin_activity_rollup_state_lock_v1", "admin_activity_rollup_clear_first_v1",
    "admin_activity_rollup_settle_first_v1", "admin_activity_rollup_advance_v1",
  ]);
  assert.deepEqual(seen[2].values, ["2026-10-25"]);
  assert.match(seen[2].text, /message\.deleted_at IS NULL AND message\.sent_at < /u);
  assert.deepEqual(seen[3].values, ["2026-10-25"]);
});

test("a later roll-up replaces only the days after the settled one", async () => {
  const seen = [];
  // node-postgres hands a DATE over as local midnight.
  const settled = new Date(2026, 9, 22);
  assert.deepEqual(await rollUpAdminActivity(database([{ settled_through: settled }], seen), { requestId: "r", now: NOW }),
    { status: "settled", from: "2026-10-22", through: "2026-10-25" });
  const clear = seen.find((query) => query.name === "admin_activity_rollup_clear_next_v1");
  assert.deepEqual(clear.values, ["2026-10-22", "2026-10-25"]);
  assert.match(clear.text, /day > \$1::date AND day <= \$2::date/u);
  const settle = seen.find((query) => query.name === "admin_activity_rollup_settle_next_v1");
  assert.deepEqual(settle.values, ["2026-10-22", "2026-10-25"]);
});

test("the scheduled tick settles only at its minute of the hour", async () => {
  // Any other minute returns before reading the deployment's databases.
  await rollUpAdminActivityOnSchedule({}, Date.parse("2026-10-27T23:40:00.000Z"));
  await assert.rejects(rollUpAdminActivityOnSchedule({}, NOW));
});
