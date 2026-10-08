import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_STALLED_BACKOFF_MS, MIN_RECHECK_MS, alarmAt, effectiveDue, mergeWake, nextStalls, stepsToRun,
} from "../src/postgres-agent-launch-schedule.ts";

const now = 1_800_000_000_000;

test("a Channel with no work keeps no alarm and forgets its stalls", () => {
  assert.deepEqual(nextStalls({ now, due: {}, stalls: { registrationStop: { count: 4, retryAt: now } }, ran: undefined }), {});
  assert.equal(alarmAt({}, now), null);
});

test("future work is looked at when it falls due", () => {
  const due = { launch: now + 30_000, reborn: now + 90_000 };
  assert.equal(alarmAt(effectiveDue(due, {}), now), now + 30_000);
});

// 2026-10-08: one stuck kind (a stop parked on an offline host, a report past
// its prune time) held the whole Channel on a 5-minute spin, and every wake
// ran every step. Each kind now backs off alone.
test("a kind a pass ran and left due backs off on its own, to a ceiling", () => {
  let stalls = {};
  const waits = [];
  for (let pass = 0; pass < 16; pass += 1) {
    stalls = nextStalls({ now, due: { registrationStop: now - 1 }, stalls, ran: new Set(["registrationStop"]) });
    waits.push(stalls.registrationStop.retryAt - now);
  }
  assert.deepEqual(waits.slice(0, 5), [MIN_RECHECK_MS, 2_000, 4_000, 8_000, 16_000]);
  assert.equal(waits.at(-1), MAX_STALLED_BACKOFF_MS);
});

test("a stuck kind does not hold back the Channel's other work", () => {
  const stalls = { registrationStop: { count: 9, retryAt: now + 20 * 60_000 } };
  const effective = effectiveDue({ registrationStop: now - 60_000, launch: now }, stalls);
  assert.deepEqual([...stepsToRun(effective, new Set(), now)], ["launch"]);
  assert.equal(alarmAt(effective, now), now + MIN_RECHECK_MS);
});

test("passes for other work neither retry a stalled kind early nor keep pushing it back", () => {
  const retryAt = now + 10 * 60_000;
  const after = nextStalls({ now, due: { registrationStop: now - 1, launch: now - 1 },
    stalls: { registrationStop: { count: 7, retryAt } }, ran: new Set(["launch"]) });
  assert.deepEqual(after.registrationStop, { count: 7, retryAt });
  assert.equal(after.launch.count, 1, "the kind that ran and stayed due starts its own backoff");
});

test("a wake runs what is due and what it names; unknown due times run everything", () => {
  const effective = effectiveDue({ runTerminal: now - 1, reborn: now + 60_000 }, {});
  assert.deepEqual([...stepsToRun(effective, new Set(["registrationStop"]), now)].sort(), ["registrationStop", "runTerminal"]);
  assert.deepEqual([...stepsToRun({}, new Set(), now)], [], "nothing due and nothing named: the read was the pass");
  assert.equal(stepsToRun(undefined, new Set(), now), undefined);
});

test("wakes accumulate; a wake that names nothing wakes every kind", () => {
  assert.deepEqual(mergeWake(undefined, ["launch"]), { all: false, named: ["launch"] });
  assert.deepEqual(mergeWake({ all: false, named: ["launch"] }, ["reborn", "launch"]), { all: false, named: ["launch", "reborn"] });
  assert.deepEqual(mergeWake({ all: false, named: ["launch"] }, undefined), { all: true });
  assert.deepEqual(mergeWake({ all: true }, ["launch"]), { all: true });
});
