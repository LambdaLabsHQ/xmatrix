import assert from "node:assert/strict";
import test from "node:test";
import { pageCoWriteDataPoint } from "../src/page-co-write-diagnostics.ts";

test("co-writing diagnostics keep only keyed identity hashes, finite outcomes and explicit missing timings", async () => {
  const point = await pageCoWriteDataPoint({ kind: "agent", id: "private-agent-id", label: "Private name",
    ownerUserId: "private-owner-id", conversationId: "private-conversation",
    runProof: { runId: "private-run", instanceId: "private-instance", executionKey: "private-execution" } },
  "private-page-id", { event: "turn_end", outcome: "stalled", turn: 42, durationMs: 120000,
    editToTurnMs: 1500, firstDeltaMs: 0, firstTextMs: null, editToFirstTextMs: null,
    maxWriteGapMs: null, writes: 0 }, "diagnostics-test-key");
  assert.match(point.indexes[0], /^[a-f0-9]{16}$/u);
  assert.match(point.blobs[5], /^[a-f0-9]{16}$/u);
  assert.match(point.blobs[8], /^[a-f0-9]{16}$/u);
  assert.match(point.blobs[10], /^[a-f0-9]{16}$/u);
  assert.deepEqual(point.blobs.slice(0, 5), ["pages", "hub", "cowrite_turn_end", "stalled", "session_clock"]);
  assert.deepEqual(point.doubles, [1, 120000, 1500, 0, -1, -1, -1, 0]);
  assert.doesNotMatch(JSON.stringify(point), /private-|Private name|diagnostics-test-key/u);
});
