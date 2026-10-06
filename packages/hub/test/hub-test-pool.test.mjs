import assert from "node:assert/strict";
import test from "node:test";

import { HUB_TEST_ADAPTIVE_SETTLE_MS } from "./hub-test-resources.mjs";
import { runAdaptivePool } from "./hub-test-pool.mjs";

const files = (count) => Array.from({ length: count }, (_, index) => `test/f${index}.test.mjs`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ taskMs = 30, idleCpus = 0, slots = Infinity } = {}) {
  const state = { running: 0, peak: 0, started: [], heldSlots: 0, peakSlots: 0, acquireCalls: 0 };
  return {
    state,
    options: {
      tickMs: 5,
      log: () => {},
      sampleIdleCpus: () => idleCpus,
      samplePressure: () => ({ cpuPressure: null, availableBytes: null }),
      acquireSlot: () => {
        state.acquireCalls += 1;
        if (state.heldSlots >= slots) return null;
        state.heldSlots += 1;
        state.peakSlots = Math.max(state.peakSlots, state.heldSlots);
        let released = false;
        return { release: () => {
          assert.equal(released, false, "a slot is released once");
          released = true;
          state.heldSlots -= 1;
        } };
      },
      runTask: async (file) => {
        state.started.push(file);
        state.running += 1;
        state.peak = Math.max(state.peak, state.running);
        await delay(taskMs);
        state.running -= 1;
        return { file, status: 0 };
      },
    },
  };
}

test("the pool keeps its floor busy and runs every file once", async () => {
  const { state, options } = harness();
  const results = await runAdaptivePool(files(9), { ...options, floor: 3, max: 3 });
  assert.equal(results.length, 9);
  assert.deepEqual([...state.started].sort(), files(9).sort());
  assert.equal(state.peak, 3);
});

test("the pool widens above its floor only while CPUs are idle, never past its ceiling", async () => {
  const busy = harness({ taskMs: 40, idleCpus: 0 });
  await runAdaptivePool(files(12), { ...busy.options, floor: 2, max: 6 });
  assert.equal(busy.state.peak, 2, "a busy host keeps the suite at its floor");

  const idle = harness({ taskMs: HUB_TEST_ADAPTIVE_SETTLE_MS * 3, idleCpus: 32 });
  await runAdaptivePool(files(8), { ...idle.options, floor: 2, max: 4 });
  assert.equal(idle.state.peak, 4, "an idle host lets it grow to the ceiling and no further");
});

test("every task holds a host slot, and full slots make the pool wait rather than overcommit", async () => {
  const { state, options } = harness({ slots: 2 });
  const results = await runAdaptivePool(files(6), { ...options, floor: 4, max: 4 });
  assert.equal(results.length, 6);
  assert.equal(state.peakSlots, 2);
  assert.equal(state.peak, 2, "no task ran without a slot");
  assert.equal(state.heldSlots, 0, "every slot came back");
});

test("stuck host slots fail the suite with a description and never start a task without one", async () => {
  const { state, options } = harness({ slots: 0 });
  await assert.rejects(
    runAdaptivePool(files(3), {
      ...options,
      floor: 2,
      max: 2,
      stallMs: 50,
      describeSlots: () => "  slot-0: locked, batch=stuck, residue pids=4242",
    }),
    /No Hub host slot could be admitted for \d+s[\s\S]*3 files were not run[\s\S]*batch=stuck, residue pids=4242/u,
  );
  assert.deepEqual(state.started, [], "waiting out the stall never starts an unslotted task");
  assert.ok(state.acquireCalls > 1, "the pool kept trying for a slot until the deadline");
});

test("a failing task rejects the pool and still returns its slot", async () => {
  const { state, options } = harness();
  await assert.rejects(
    runAdaptivePool(files(3), {
      ...options,
      floor: 1,
      max: 1,
      runTask: async () => {
        throw new Error("cleanup failed");
      },
    }),
    /cleanup failed/u,
  );
  await delay(20);
  assert.equal(state.heldSlots, 0);
});

test("low available memory holds back every admission, the floor included", async () => {
  const { state, options } = harness();
  let availableBytes = 1024 ** 3;
  const pending = runAdaptivePool(files(2), {
    ...options,
    floor: 2,
    max: 2,
    samplePressure: () => ({ cpuPressure: null, availableBytes }),
  });
  await delay(40);
  assert.deepEqual(state.started, [], "nothing starts while the host is short of memory");
  availableBytes = 16 * 1024 ** 3;
  const results = await pending;
  assert.equal(results.length, 2);
});

test("CPU pressure from other jobs holds back the floor without consuming host slots", async () => {
  const { state, options } = harness();
  let cpuPressure = 25;
  const pending = runAdaptivePool(files(3), {
    ...options,
    floor: 3,
    max: 3,
    samplePressure: () => ({ cpuPressure, availableBytes: 16 * 1024 ** 3 }),
  });
  await delay(40);
  assert.deepEqual(state.started, [], "free slots and memory cannot override CPU pressure");
  assert.equal(state.acquireCalls, 0, "waiting for capacity holds no host slot");
  cpuPressure = 4;
  const results = await pending;
  assert.equal(results.length, 3, "every test still runs after pressure clears");
  assert.equal(state.heldSlots, 0);
});
