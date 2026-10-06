import assert from "node:assert/strict";
import { test } from "node:test";
import { readIndexRoutesAuthSpaceSource } from "./index-routes-auth-space-source.mjs";

import {
  AUTHORITY_PROBE_INITIAL_DELAY_MS,
  AUTHORITY_PROBE_MAX_DELAY_MS,
  awaitAuthorityProbeBackoff,
  probeDelayMs,
  probeAuthorityUntilTerminal,
} from "../src/authority-probe-backoff.ts";

/** Advances only when the code under test sleeps, so probe timing is exact. */
function fakeClock(startMs = 1_000) {
  const state = { ms: startMs, slept: [] };
  return {
    state,
    now: () => state.ms,
    sleep: (delay) => { state.slept.push(delay); state.ms += delay; return Promise.resolve(); },
  };
}

/**
 * Drives a sleep-first wait — the shape both auth-space routes use — to its
 * deadline and reports what actually happened. Both budgets in this file come
 * from running the real code, never from restating the schedule.
 */
async function runSleepFirstWait(deadlineMs) {
  const clock = fakeClock();
  const deadlineAtMs = clock.state.ms + deadlineMs;
  const probedAt = [clock.state.ms]; // the caller's first read, before the loop
  for (let attempt = 1; ; attempt += 1) {
    if (!await awaitAuthorityProbeBackoff(attempt, deadlineAtMs, clock.now, clock.sleep)) break;
    probedAt.push(clock.state.ms);
  }
  return { probedAt, deadlineAtMs, endedAtMs: clock.state.ms, slept: clock.state.slept };
}

/** Same, for the probe-first shape the reborn stop wait uses. */
async function runProbeFirstWait(deadlineMs, terminalAtProbe) {
  const clock = fakeClock();
  const deadlineAtMs = clock.state.ms + deadlineMs;
  const probedAt = [];
  const result = await probeAuthorityUntilTerminal({
    deadlineAtMs,
    probe: async () => { probedAt.push(clock.state.ms); return terminalAtProbe?.(probedAt.length); },
    now: clock.now,
    sleep: clock.sleep,
  });
  return { result, probedAt, deadlineAtMs, endedAtMs: clock.state.ms, slept: clock.state.slept };
}

const authSpace = readIndexRoutesAuthSpaceSource();

/** The deadline both waits use. */
const DEADLINE_MS = 20_000;

test("the probe-first wait issues its first probe before any sleep", async () => {
  const { probedAt } = await runProbeFirstWait(DEADLINE_MS, (count) => count === 2 ? "done" : undefined);

  assert.equal(probedAt[0], 1_000, "the first probe must run at t=0, before any sleep");
  assert.equal(probedAt[1], 1_100, "the second probe follows the first backoff");
});

test("the probe-first wait issues no probe at or past the deadline", async () => {
  const { result, probedAt, deadlineAtMs, endedAtMs } = await runProbeFirstWait(DEADLINE_MS);

  assert.equal(result, undefined, "an unresolved wait must report a timeout");
  // The regression: checking the deadline only before sleeping let the final
  // clamped sleep land exactly on the deadline and then probe once more.
  for (const at of probedAt) {
    assert.ok(at < deadlineAtMs, `probed at ${at}, deadline was ${deadlineAtMs}`);
  }
  assert.equal(endedAtMs, deadlineAtMs, "the wait still ends exactly at the deadline");
});

for (const scenario of [
  { title: "an already-expired probe-first wait never probes", budgetMs: 0, result: undefined, probes: 0 },
  { title: "a terminal probe stops the wait immediately", budgetMs: DEADLINE_MS, result: "completed", probes: 1 },
]) {
  test(scenario.title, async () => {
    const { result, probedAt, slept } = await runProbeFirstWait(scenario.budgetMs, () => "completed");
    assert.equal(result, scenario.result);
    assert.equal(probedAt.length, scenario.probes);
    assert.deepEqual(slept, [], "an expired or resolved wait must not sleep");
  });
}

test("a probe that throws propagates without being retried", async () => {
  const clock = fakeClock();
  let probes = 0;
  await assert.rejects(
    probeAuthorityUntilTerminal({
      deadlineAtMs: clock.state.ms + DEADLINE_MS,
      probe: async () => { probes += 1; throw new Error("Machine Daemon could not terminate"); },
      now: clock.now,
      sleep: clock.sleep,
    }),
    /could not terminate/u,
  );
  assert.equal(probes, 1);
});

test("backoff never overshoots the deadline", async () => {
  const { slept, endedAtMs, deadlineAtMs } = await runSleepFirstWait(DEADLINE_MS);
  const total = slept.reduce((sum, delay) => sum + delay, 0);
  assert.ok(total <= DEADLINE_MS, `slept ${total}ms against a ${DEADLINE_MS}ms deadline`);
  // The final delay is the clamped remainder, so the budget is spent exactly.
  assert.equal(total, DEADLINE_MS);
  assert.equal(endedAtMs, deadlineAtMs);
  // A spent deadline yields no further delay, which callers read as "stop".
  assert.equal(probeDelayMs(1, 0), 0);
  assert.equal(probeDelayMs(9, -1), 0);
  // Clamping also applies mid-schedule, not only at the tail.
  assert.equal(probeDelayMs(5, 50), 50);
});

test("delays grow from the previous flat interval up to a fixed ceiling", () => {
  assert.equal(AUTHORITY_PROBE_INITIAL_DELAY_MS, 100);
  assert.equal(AUTHORITY_PROBE_MAX_DELAY_MS, 500);
  assert.equal(probeDelayMs(1, DEADLINE_MS), 100);
  assert.equal(probeDelayMs(2, DEADLINE_MS), 200);
  assert.equal(probeDelayMs(3, DEADLINE_MS), 400);
  for (const attempt of [4, 5, 6, 7, 40]) {
    assert.equal(probeDelayMs(attempt, DEADLINE_MS), AUTHORITY_PROBE_MAX_DELAY_MS);
  }
  assert.throws(() => probeDelayMs(0, DEADLINE_MS), TypeError);
});

test("every Authority wait shares the one backoff policy", () => {
  // Delete waits for the spawn command, then for the Run's record of it, then for the stop.
  // The mention adapter no longer waits on an Authority status: reborn and
  // handoff stops belong to the durable continuation intent.
  for (const [name, source] of [["auth-space", authSpace]]) {
    assert.match(source, /from "\.\/authority-probe-backoff"/u, `${name} must import the shared policy`);
    // No site may keep its own sleep against an Authority status wait.
    assert.doesNotMatch(
      source,
      /setTimeout\(resolve, (INSTANCE_ABANDON_RESULT_POLL_MS|REBORN_STOP_RESULT_POLL_MS)\)/u,
      `${name} must not keep a private poll interval`,
    );
  }
});

test("a wait that never resolves still ends at the deadline with the same outcome", async () => {
  const sleepFirst = await runSleepFirstWait(DEADLINE_MS);
  const probeFirst = await runProbeFirstWait(DEADLINE_MS);

  // Both shapes time out at the same instant the flat interval did, so each
  // route still falls through to its unchanged 202 / throw branch.
  for (const wait of [sleepFirst, probeFirst]) {
    assert.equal(wait.endedAtMs, wait.deadlineAtMs);
  }
  assert.equal(probeFirst.result, undefined, "a probe-first timeout reports no terminal value");
  // Growth is real, not a flat interval wearing a new name.
  assert.deepEqual(sleepFirst.slept.slice(0, 5), [100, 200, 400, 500, 500]);
  assert.equal(sleepFirst.slept.at(-1) <= AUTHORITY_PROBE_MAX_DELAY_MS, true);
});

test("a wait that resolves early stops immediately and sleeps only once", async () => {
  let clock = 0;
  const slept = [];
  const sleep = (ms) => { slept.push(ms); clock += ms; return Promise.resolve(); };
  const proceed = await awaitAuthorityProbeBackoff(1, clock + DEADLINE_MS, () => clock, sleep);

  assert.equal(proceed, true);
  assert.deepEqual(slept, [AUTHORITY_PROBE_INITIAL_DELAY_MS]);
});
