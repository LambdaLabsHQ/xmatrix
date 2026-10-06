import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_HOST_TRACE_MAX_RESPONSE_BYTES,
  AGENT_HOST_TRACE_MAX_WAIT_MS,
  agentHostTraceCursor,
  agentHostTraceWaitMs,
  parseAgentHostTraceCursor,
  sanitizeAgentHostTraceHistory,
} from "../src/agent-host-trace.ts";

const binding = {
  instanceId: "instance:1",
  ownerUserId: "owner-1",
  agentId: "agent-1",
  agentName: "claude",
  channelId: "channel-1",
  allowedChannelIds: ["channel-1"],
  runId: "run-1",
  machineId: "machine-1",
  hostId: "host-1",
};

function event(index, extra = {}) {
  const second = String(index % 60).padStart(2, "0");
  const minute = String(Math.floor(index / 60)).padStart(2, "0");
  return {
    id: `event:${String(index).padStart(4, "0")}`,
    type: "event_published",
    channelId: "channel-1",
    metadata: { eventType: "llm_trace", payload: { delta: `step ${index}`, ...extra } },
    timestamp: `2026-09-25T10:${minute}:${second}Z`,
  };
}

function result(events, extra = {}) {
  return {
    type: "trace_history_result",
    requestId: "request-1",
    instanceId: "instance:1",
    availability: "available",
    complete: true,
    events,
    nextCursor: null,
    ...extra,
  };
}

test("a response over the byte bound is cut at an event boundary, not rejected", () => {
  // Canonical scope fields multiply each event; this page used to fail whole.
  const events = Array.from({ length: 300 }, (_, index) => event(index, { output: "x".repeat(4_000) }))
    .reverse();
  const page = sanitizeAgentHostTraceHistory(result(events), binding, { maxEvents: 500 });
  assert.equal(page.availability, "available");
  assert.ok(page.events.length > 0 && page.events.length < events.length);
  assert.ok(JSON.stringify(page.events).length <= AGENT_HOST_TRACE_MAX_RESPONSE_BYTES);
  assert.equal(page.complete, false);
  assert.equal(page.events[0].id, "event:0299", "the newest event leads the page");
  assert.equal(page.nextCursor, agentHostTraceCursor(page.events.at(-1)));

  const older = events.filter((item) =>
    item.timestamp < page.events.at(-1).timestamp);
  const next = sanitizeAgentHostTraceHistory(result(older), binding, {
    maxEvents: 500, before: page.nextCursor,
  });
  assert.equal(next.events[0].id, older[0].id, "the next page resumes right after the cut");
});

test("a paging host's cursor passes through and closes on the oldest page", () => {
  const newest = sanitizeAgentHostTraceHistory(result([event(3), event(2)], {
    complete: false, nextCursor: agentHostTraceCursor(event(2)),
  }), binding, { maxEvents: 2 });
  assert.deepEqual(newest.events.map((item) => item.id), ["event:0003", "event:0002"]);
  assert.equal(newest.nextCursor, agentHostTraceCursor(event(2)));
  assert.equal(newest.complete, false);

  const oldest = sanitizeAgentHostTraceHistory(result([event(1), event(0)]), binding, {
    maxEvents: 2, before: newest.nextCursor,
  });
  assert.deepEqual(oldest.events.map((item) => item.id), ["event:0001", "event:0000"]);
  assert.equal(oldest.nextCursor, null);
  assert.equal(oldest.complete, true);
});

test("a host that predates paging never answers an older-page read with its newest page", () => {
  const legacy = result([event(3), event(2)]);
  delete legacy.nextCursor;
  const first = sanitizeAgentHostTraceHistory(legacy, binding, { maxEvents: 500 });
  assert.equal(first.events.length, 2);
  assert.equal(first.nextCursor, null);

  const older = sanitizeAgentHostTraceHistory(legacy, binding, {
    maxEvents: 500, before: agentHostTraceCursor(event(2)),
  });
  assert.deepEqual(older.events, []);
  assert.equal(older.reason, "host_paging_unsupported");
  assert.equal(older.complete, false);
});

test("events at or after the requested cursor are dropped even if the host sends them", () => {
  const page = sanitizeAgentHostTraceHistory(result([event(3), event(2), event(1)]), binding, {
    maxEvents: 500, before: agentHostTraceCursor(event(2)),
  });
  assert.deepEqual(page.events.map((item) => item.id), ["event:0001"]);
});

test("equal instants order by event id, the same order the Rust host pages in", () => {
  const at = "2026-09-25T10:00:00Z";
  const ids = ["event:c", "event:a", "event:b"];
  const page = sanitizeAgentHostTraceHistory(result(ids.map((id) => ({ ...event(0), id, timestamp: at }))),
    binding, { maxEvents: 500, before: `${at}|event:d` });
  assert.deepEqual(page.events.map((item) => item.id), ["event:c", "event:b", "event:a"]);
});

test("cursors are validated before they reach the host", () => {
  assert.ok(parseAgentHostTraceCursor("2026-09-25T10:00:00.123Z|event:1"));
  for (const invalid of ["event:1", "not-a-time|event:1", "2026-09-25T10:00:00Z|", 7]) {
    assert.equal(parseAgentHostTraceCursor(invalid), undefined, String(invalid));
  }
  const malformedHostCursor = sanitizeAgentHostTraceHistory(result([event(1)], {
    nextCursor: "garbage",
  }), binding, { maxEvents: 500 });
  assert.equal(malformedHostCursor, undefined);
});

test("only a live since delta may wait on the host, and never past the bound", () => {
  const since = "2026-09-25T10:00:00Z";
  assert.equal(agentHostTraceWaitMs({ since, waitMs: 5_000 }), 5_000);
  assert.equal(agentHostTraceWaitMs({ since, waitMs: 10 * AGENT_HOST_TRACE_MAX_WAIT_MS }), AGENT_HOST_TRACE_MAX_WAIT_MS);
  assert.equal(agentHostTraceWaitMs({ waitMs: 5_000 }), 0, "a head read answers at once");
  assert.equal(agentHostTraceWaitMs({ since, before: agentHostTraceCursor(event(1)), waitMs: 5_000 }), 0,
    "a page read answers at once");
  for (const waitMs of [undefined, 0, -1, 1.5, Number.NaN]) {
    assert.equal(agentHostTraceWaitMs({ since, waitMs }), 0);
  }
});
