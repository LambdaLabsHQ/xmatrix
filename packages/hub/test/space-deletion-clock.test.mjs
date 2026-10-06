import assert from "node:assert/strict";
import test from "node:test";

import { SpaceDeletionClock } from "../src/space-deletion-clock.ts";
import { purgeDeletedSpace } from "../src/space-deletion-purge.ts";

function fixture(purge, now = () => 1_000) {
  let stored, alarm = null;
  const storage = { async get() { return stored; }, async put(_key, value) { stored = value; },
    async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; } };
  return { clock: new SpaceDeletionClock(storage, purge, now), alarm: () => alarm };
}

test("the clock is scoped to one Space and sleeps until PostgreSQL's due time", async () => {
  const f = fixture(async (space) => { assert.equal(space, "space"); return 900_000; });
  await f.clock.arm("space", 500_000);
  assert.equal(f.alarm(), 500_000);
  await assert.rejects(f.clock.arm("other", 1), /mismatch/u);
  await f.clock.arm("space", 700_000);
  assert.equal(f.alarm(), 500_000, "an earlier wake is kept");
  await f.clock.alarm();
  assert.equal(f.alarm(), 900_000);
});

test("a failed purge keeps a recovery alarm, and a finished or restored Space stops waking", async () => {
  const failing = fixture(async () => { throw new Error("database unavailable"); });
  await failing.clock.arm("space", 1_000);
  await assert.rejects(failing.clock.alarm());
  assert.equal(failing.alarm(), 301_000);
  const done = fixture(async () => null);
  await done.clock.arm("space", 1_000);
  await done.clock.alarm();
  assert.equal(done.alarm(), null);
});

test("a deletion scheduled again during a purge read keeps its wake", async () => {
  let finish, started;
  const pending = new Promise((resolve) => { finish = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const f = fixture(async () => { started(); await pending; return null; });
  await f.clock.arm("space", 1_000);
  const running = f.clock.alarm();
  await entered;
  await f.clock.arm("space", 604_801_000);
  finish();
  await running;
  assert.equal(f.alarm(), 604_801_000, "the restored-then-deleted Space still purges");
});

function purger(steps) {
  const recorded = [];
  return {
    recorded,
    spaces: {
      async purgeSpaceStep() { return steps.shift() ?? { status: "completed", deletion: {} }; },
      async recordSpacePurgeObjects(input) { recorded.push(input); return true; },
    },
  };
}

test("the purge deletes object keys before recording them, then drains row steps", async () => {
  const deleted = [];
  const { spaces, recorded } = purger([
    { status: "objects", objectKeys: ["restricted/a/objects/1"], cursor: "restricted/a/objects/1", exhausted: false },
    { status: "objects", objectKeys: [], cursor: "restricted/z", exhausted: true },
    { status: "rows", purgedRows: 2_000 },
    { status: "rows", purgedRows: 12 },
  ]);
  const bucket = { async delete(keys) { assert.equal(recorded.length, deleted.length ? 1 : 0); deleted.push(...keys); } };
  const result = await purgeDeletedSpace({ spaces, bucket, spaceId: "space" });
  assert.deepEqual(result, { nextAt: null, rows: 2_012, objects: 1 });
  assert.deepEqual(deleted, ["restricted/a/objects/1"]);
  assert.deepEqual(recorded.map(({ cursor, exhausted, deleted: count }) => [cursor, exhausted, count]),
    [["restricted/a/objects/1", false, 1], ["restricted/z", true, 0]]);
});

test("the purge waits for the restore window and stops for a restored Space", async () => {
  const waiting = purger([{ status: "restorable", purgeAfter: "2026-10-03T00:00:00.000Z" }]);
  assert.equal((await purgeDeletedSpace({ spaces: waiting.spaces, bucket: { async delete() {} }, spaceId: "s" }))
    .nextAt, Date.parse("2026-10-03T00:00:00.000Z"));
  const restored = purger([{ status: "absent" }]);
  assert.equal((await purgeDeletedSpace({ spaces: restored.spaces, bucket: { async delete() {} }, spaceId: "s" }))
    .nextAt, null);
});

test("a failed object delete records nothing, so the same keys are retried", async () => {
  const { spaces, recorded } = purger([
    { status: "objects", objectKeys: ["restricted/a/objects/1"], cursor: "restricted/a/objects/1", exhausted: true },
  ]);
  await assert.rejects(purgeDeletedSpace({ spaces, spaceId: "space",
    bucket: { async delete() { throw new Error("R2 unavailable"); } } }), /R2 unavailable/u);
  assert.deepEqual(recorded, []);
});

test("the purge yields when its time budget is spent", async () => {
  let clock = 0;
  const spaces = { async purgeSpaceStep() { clock += 10; return { status: "rows", purgedRows: 500 }; },
    async recordSpacePurgeObjects() { return true; } };
  const result = await purgeDeletedSpace({ spaces, bucket: { async delete() {} }, spaceId: "space",
    budgetMs: 25, now: () => clock });
  assert.deepEqual(result, { nextAt: 1_030, rows: 1_500, objects: 0 });
});
