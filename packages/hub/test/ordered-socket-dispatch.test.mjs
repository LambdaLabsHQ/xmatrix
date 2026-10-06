import assert from "node:assert/strict";
import test from "node:test";

import { OrderedSocketDispatch } from "../src/runtime-transport/ordered-socket-dispatch.ts";

const socket = () => ({});
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("frames on one socket keep their order", async () => {
  const dispatch = new OrderedSocketDispatch("test", 1_000);
  const ws = socket();
  const seen = [];
  const first = dispatch.enqueue(ws, async () => { await tick(20); seen.push("first"); });
  const second = dispatch.enqueue(ws, async () => { seen.push("second"); });
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["first", "second"]);
});

test("an operation that never settles stops holding the socket after its budget", async () => {
  const dispatch = new OrderedSocketDispatch("test", 30);
  const ws = socket();
  const other = socket();
  let hungStarts = 0;
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const hung = dispatch.enqueue(ws, () => { hungStarts += 1; return new Promise(() => {}); });
    const seen = [];
    const next = dispatch.enqueue(ws, async () => { seen.push("next"); });
    // Another socket's queue never waited on the stall.
    await dispatch.enqueue(other, async () => { seen.push("other"); });
    assert.deepEqual(seen, ["other"]);
    await Promise.all([hung, next]);
    assert.deepEqual(seen, ["other", "next"]);
    assert.equal(hungStarts, 1, "the stalled operation is not repeated");
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /exceeded its budget/);
    assert.deepEqual(logged[0][1], { domain: "test", budgetMs: 30 });
  } finally {
    console.error = originalError;
  }
});

test("a failing operation still releases the next frame", async () => {
  const dispatch = new OrderedSocketDispatch("test", 1_000);
  const ws = socket();
  const failed = dispatch.enqueue(ws, async () => { throw new Error("boom"); });
  await assert.rejects(failed, /boom/);
  let ran = false;
  await dispatch.enqueue(ws, async () => { ran = true; });
  assert.equal(ran, true);
});
