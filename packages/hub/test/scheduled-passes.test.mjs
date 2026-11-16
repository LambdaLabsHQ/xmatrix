import assert from "node:assert/strict";
import { test } from "node:test";

import { runScheduledLanes } from "../src/scheduled-passes.ts";

const gate = () => { let open; const wait = new Promise(resolve => { open = resolve; }); return { wait, open }; };

test("a lane runs one pass at a time while lanes run side by side", async () => {
  const running = { a: 0, b: 0 }, peak = { a: 0, b: 0, both: 0 }, order = [];
  const pass = (lane, name) => ({ name, work: async () => {
    running[lane]++;
    peak[lane] = Math.max(peak[lane], running[lane]);
    peak.both = Math.max(peak.both, running.a + running.b);
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push(name);
    running[lane]--;
  } });
  await runScheduledLanes([[pass("a", "a1"), pass("a", "a2"), pass("a", "a3")], [pass("b", "b1"), pass("b", "b2")]], () => {});
  assert.deepEqual(peak, { a: 1, b: 1, both: 2 });
  assert.deepEqual(order.filter(name => name.startsWith("a")), ["a1", "a2", "a3"]);
  assert.equal(order.length, 5);
});

test("a failed pass is reported by name and the lane goes on", async () => {
  const failures = [], ran = [];
  await runScheduledLanes([[
    { name: "first", work: async () => { throw new Error("down"); } },
    { name: "sync", work: () => { throw new Error("thrown"); } },
    { name: "last", work: async () => { ran.push("last"); } },
  ]], (name, error) => failures.push([name, error.message]));
  assert.deepEqual(failures, [["first", "down"], ["sync", "thrown"]]);
  assert.deepEqual(ran, ["last"]);
});

test("a lane stops waiting for a slow pass, which still reports its own failure", async () => {
  const slow = gate(), failures = [], ran = [];
  await runScheduledLanes([[
    { name: "slow", work: async () => { await slow.wait; throw new Error("late"); } },
    { name: "next", work: async () => { ran.push("next"); } },
  ]], name => failures.push(name), 10);
  assert.deepEqual(ran, ["next"]);
  assert.deepEqual(failures, []);
  slow.open();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(failures, ["slow"]);
});
