import assert from "node:assert/strict";
import test from "node:test";

import {
  tryLoadRuntimePresenceSnapshotEntries,
  loadRuntimePresenceSnapshotEntries,
} from "../src/runtime-transport/runtime-presence-snapshot.ts";
const url = new URL("https://runtime.test/internal/human-presence");

test("streamed presence preserves UTF-8 characters split across chunks and clears its deadline", async () => {
  const sessions = [{ userId: "viewer", name: "在线用户" }];
  const bytes = new TextEncoder().encode(JSON.stringify({ sessions }));
  let signal;
  const runtime = { async fetch(request) {
    signal = request.signal;
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }));
  } };
  assert.deepEqual(await tryLoadRuntimePresenceSnapshotEntries(runtime, url, 50), sessions);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(signal.aborted, false);
});

test("the optional and legacy readers retain their distinct unavailable results", async () => {
  const runtime = { async fetch() { return Response.json({ sessions: null }); } };
  assert.equal(await tryLoadRuntimePresenceSnapshotEntries(runtime, url, 50), null);
  assert.deepEqual(await loadRuntimePresenceSnapshotEntries(runtime, url), []);
});

test("a failed response cancels its unread body", async () => {
  let cancelled = false;
  const runtime = { async fetch() {
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  } };
  assert.equal(await tryLoadRuntimePresenceSnapshotEntries(runtime, url, 50), null);
  assert.equal(cancelled, true);
});

test("legacy error handling does not wait for stalled body cancellation", { timeout: 1_000 }, async () => {
  let cancelled = false;
  const runtime = { async fetch() {
    return new Response(new ReadableStream({ cancel() {
      cancelled = true;
      return new Promise(() => {});
    } }), { status: 503 });
  } };
  assert.deepEqual(await loadRuntimePresenceSnapshotEntries(runtime, url), []);
  assert.equal(cancelled, true);
});

test("a rejected cancellation does not escape optional error handling", async () => {
  const runtime = { async fetch() {
    return new Response(new ReadableStream({ cancel() {
      return Promise.reject(new Error("Cancellation failed"));
    } }), { status: 503 });
  } };
  assert.equal(await tryLoadRuntimePresenceSnapshotEntries(runtime, url, 50), null);
});
