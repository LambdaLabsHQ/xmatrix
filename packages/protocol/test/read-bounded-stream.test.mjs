import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTypescriptModule } from "./load-typescript-module.mjs";

const { readBoundedStream } = await loadTypescriptModule(new URL("../src/read-bounded-stream.ts", import.meta.url));
const tooLarge = new Error("too large");

test("bounded reads join exact-limit bytes, including empty bodies, and release their reader", async () => {
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2]));
    controller.enqueue(new Uint8Array([3]));
    controller.close();
  } });
  assert.deepEqual(await readBoundedStream(stream, 3, () => tooLarge), new Uint8Array([1, 2, 3]));
  assert.equal(stream.locked, false);
  assert.deepEqual(await readBoundedStream(null, 0, () => tooLarge), new Uint8Array());
});

// Native tee cancellation waits for BOTH branches. Refusing an oversized body
// must not depend on a logger/clone finishing its independent branch.
test("an oversized tee branch rejects before its sibling is cancelled", async t => {
  let cancelled = false;
  const source = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; } });
  const [body, sibling] = source.tee();
  t.after(async () => { await sibling.cancel(); });
  const result = readBoundedStream(body, 3, () => tooLarge).then(() => "accepted", error => error);
  const answer = await Promise.race([result, new Promise(resolve => setImmediate(() => resolve("still waiting")))]);
  assert.equal(answer, tooLarge);
  assert.equal(body.locked, false);
  assert.equal(cancelled, false, "the upstream is still serving the other branch");
});

test("upstream cancellation failure cannot replace the size error", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); },
    cancel() { throw new Error("cleanup failed"); } });
  await assert.rejects(readBoundedStream(stream, 3, () => tooLarge), error => error === tooLarge);
  assert.equal(stream.locked, false);
});

test("abort interrupts a pending read without waiting for upstream cleanup", async t => {
  let finishCancel;
  const cancellation = new Promise(resolve => { finishCancel = resolve; });
  t.after(() => finishCancel());
  const stream = new ReadableStream({ cancel: () => cancellation });
  const controller = new AbortController();
  const reason = new Error("deadline");
  const result = readBoundedStream(stream, 3, () => tooLarge, controller.signal);
  controller.abort(reason);
  await assert.rejects(result, error => error === reason);
  assert.equal(stream.locked, false);
});

test("stream failures propagate unchanged and release their reader", async () => {
  const failure = new Error("transport lost");
  const stream = new ReadableStream({ pull(controller) { controller.error(failure); } });
  await assert.rejects(readBoundedStream(stream, 3, () => tooLarge), error => error === failure);
  assert.equal(stream.locked, false);
});
