import assert from "node:assert/strict";
import test from "node:test";

import { MAX_STALLED_BACKOFF_MS, MIN_RECHECK_MS, dueSteps, nextAlarm } from "../src/postgres-agent-launch-schedule.ts";

const now = 1_800_000_000_000;

test("a Channel with no work keeps no alarm and forgets its stall count", () => {
  assert.deepEqual(nextAlarm({ now, due: {}, stalled: 7 }), { alarmAt: null, stalled: 0 });
});

test("future work is looked at when it falls due, with no backoff", () => {
  assert.deepEqual(nextAlarm({ now, due: { launch: now + 30_000, reborn: now + 90_000 }, stalled: 4 }),
    { alarmAt: now + 30_000, stalled: 0 });
});

// 2026-10-08: about 30 Channels each holding an item nothing could move ran a
// full 12-transaction pass every 16-18 seconds: the stall count lived in
// memory and reset whenever the object was evicted. 80% of the primary
// database's sessions were these passes.
test("work still due after a pass backs off exponentially to a five-minute ceiling", () => {
  let stalled = 0;
  const waits = [];
  for (let pass = 0; pass < 14; pass += 1) {
    const next = nextAlarm({ now, due: { registrationStop: now - 1_000 }, stalled });
    stalled = next.stalled;
    waits.push(next.alarmAt - now);
  }
  assert.deepEqual(waits.slice(0, 5), [MIN_RECHECK_MS, 2_000, 4_000, 8_000, 16_000]);
  assert.equal(Math.max(...waits), MAX_STALLED_BACKOFF_MS);
  assert.equal(waits.at(-1), MAX_STALLED_BACKOFF_MS);
  assert.equal(stalled, 14, "the count carries across passes; the caller persists it");
});

test("an unreadable due time counts as due now and backs off too", () => {
  assert.deepEqual(nextAlarm({ now, due: undefined, stalled: 2 }), { alarmAt: now + 4_000, stalled: 3 });
});

test("a timed pass runs only the steps whose work was due; unknown due runs every step", () => {
  assert.deepEqual([...dueSteps({ launch: now - 1, runTerminal: now + 60_000, automation: now }, now)].sort(),
    ["automation", "launch"]);
  assert.deepEqual([...dueSteps({}, now)], []);
  assert.equal(dueSteps(undefined, now), undefined);
});
