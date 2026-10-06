const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  agentTraceHistoryStatusCopy,
  agentTraceOlderPageErrorCopy,
  holdAgentTraceReadThroughFailure,
  mergeTraceInstanceHistoryResponses,
  parseAgentTraceHistoryResponse,
  planAgentTraceHistoryRequests,
  startAgentTraceHistoryBootstrap,
  startAgentTraceHistorySync,
} = require("./agent-trace-on-demand.ts");

function trace(
  instanceId,
  id = `event:${instanceId}`,
  timestamp = "2026-07-20T00:00:00.000Z"
) {
  return {
    id,
    type: "event_published",
    channelId: "channel:one",
    agentId: "agent:codex",
    agentName: "codex",
    timestamp,
    metadata: {
      eventType: "llm_trace",
      payload: {
        channelId: "channel:one",
        agent: { id: "agent:codex", instanceId },
        phase: "assistant_delta",
        payload: { delta: id },
      },
    },
  };
}

function history(instanceId, options = {}) {
  return {
    availability: "available",
    complete: true,
    events: [trace(instanceId)],
    cursor: null,
    ...options,
  };
}

/** The host's answer: one history page carrying `events`. */
function historyResponse(instanceId, events, page = {}) {
  return Response.json(history(instanceId, { events, ...page }));
}

/** An `onEvents` callback that records the ids of the events it accepts. */
function recordEventIds(accepted) {
  return (_instanceId, events) => accepted.push(...events.map((event) => event.id));
}

/** A trace event `second` seconds into the test's minute. */
function traceAtSecond(instanceId, id, second) {
  return trace(instanceId, id, `2026-07-20T00:00:${String(second).padStart(2, "0")}Z`);
}

test("wire parsing fails closed on false completeness and cross-instance payload claims", () => {
  assert.deepEqual(
    parseAgentTraceHistoryResponse(
      { availability: "expired", complete: false, events: [], reason: "host_expired", cursor: null },
      "instance:one"
    ),
    {
      availability: "expired",
      complete: false,
      events: [],
      reason: "host_expired",
      cursor: null,
      nextCursor: null,
    }
  );
  assert.throws(
    () => parseAgentTraceHistoryResponse(
      { availability: "unavailable", complete: true, events: [], cursor: null },
      "instance:one"
    ),
    /cannot claim retained history/
  );
  assert.throws(
    () => parseAgentTraceHistoryResponse(history("instance:other"), "instance:one"),
    /invalid event/
  );
  assert.throws(
    () => parseAgentTraceHistoryResponse({ ...history("instance:one"), cursor: "next" }, "instance:one"),
    /incomplete/
  );
});

test("aggregate completeness stays false when any exact instance is unavailable or expired", () => {
  const available = parseAgentTraceHistoryResponse(history("instance:available"), "instance:available");
  for (const availability of ["unavailable", "expired"]) {
    const missing = parseAgentTraceHistoryResponse({
      availability,
      complete: false,
      events: [],
      reason: availability === "expired" ? "host_expired" : "host_offline",
      cursor: null,
    }, "instance:missing");
    const merged = mergeTraceInstanceHistoryResponses(
      ["instance:available", "instance:missing"],
      [
        { instanceId: "instance:available", response: available },
        { instanceId: "instance:missing", response: missing },
      ]
    );
    assert.equal(merged.complete, false);
    assert.deepEqual(merged.events.map((event) => event.id), ["event:instance:available"]);
  }

  const allAvailable = mergeTraceInstanceHistoryResponses(
    ["instance:available", "instance:second"],
    [
      { instanceId: "instance:available", response: available },
      {
        instanceId: "instance:second",
        response: parseAgentTraceHistoryResponse(history("instance:second"), "instance:second"),
      },
    ]
  );
  assert.equal(allAvailable.complete, true);
  assert.equal(allAvailable.events.length, 2);
});

test("bootstrap preserves available events but stays incomplete beside unavailable or rejected instances", async (t) => {
  for (const peer of ["unavailable", "rejected"]) {
    await t.test(peer, async () => {
      const states = [];
      const accepted = [];
      let completed;
      const bootstrap = startAgentTraceHistoryBootstrap({
        instanceIds: ["instance:available", `instance:${peer}`],
        fetchHistory: async (instanceId) => {
          if (instanceId === "instance:available") {
            return Response.json(history(instanceId));
          }
          if (peer === "unavailable") {
            return Response.json({
              availability: "unavailable",
              complete: false,
              events: [],
              reason: "host_offline",
              cursor: null,
            });
          }
          return Response.json({ code: "trace_access_denied" }, { status: 403 });
        },
        onState: (state) => states.push(state),
        onEvents: (instanceId, events) => accepted.push([instanceId, ...events.map((event) => event.id)]),
        onComplete: (result) => {
          completed = result;
        },
      });

      await bootstrap.done;
      assert.deepEqual(accepted, [["instance:available", "event:instance:available"]]);
      assert.deepEqual(completed, {
        complete: false,
        events: [trace("instance:available")],
      });
      assert.deepEqual(
        states.find((state) => state.instanceId === `instance:${peer}` && state.phase !== "loading"),
        peer === "unavailable"
          ? {
              instanceId: "instance:unavailable",
              phase: "unavailable",
              complete: false,
              eventCount: 0,
              reason: "host_offline",
            }
          : {
              instanceId: "instance:rejected",
              phase: "error",
              complete: false,
              eventCount: 0,
              reason: "trace_access_denied",
            }
      );
    });
  }
});

test("multi-instance bootstrap sends one bounded exact request per deduplicated instance", async () => {
  const calls = [];
  const states = [];
  const accepted = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const bootstrap = startAgentTraceHistoryBootstrap({
    instanceIds: ["instance:a", "instance:b", "instance:a", "instance:c"],
    concurrency: 2,
    fetchHistory: async (instanceId, options) => {
      calls.push([instanceId, options.limit]);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return Response.json(history(instanceId));
    },
    onState: (state) => states.push(state),
    onEvents: (instanceId, events) => accepted.push([instanceId, events.map((event) => event.id)]),
  });

  await bootstrap.done;
  assert.deepEqual(
    calls.map(([instanceId]) => instanceId).sort(),
    ["instance:a", "instance:b", "instance:c"]
  );
  assert.ok(calls.every(([, limit]) => limit === 500));
  assert.equal(peakInFlight, 2);
  assert.deepEqual(accepted.map(([instanceId]) => instanceId).sort(), ["instance:a", "instance:b", "instance:c"]);
  assert.equal(states.filter((state) => state.phase === "available").length, 3);
});

test("cancelled target ignores a late response even when the fetch implementation ignores AbortSignal", async () => {
  let resolveResponse;
  const states = [];
  const accepted = [];
  let completeCalls = 0;
  const bootstrap = startAgentTraceHistoryBootstrap({
    instanceIds: ["instance:late"],
    fetchHistory: () => new Promise((resolve) => {
      resolveResponse = resolve;
    }),
    onState: (state) => states.push(state),
    onEvents: (_instanceId, events) => accepted.push(...events),
    onComplete: () => {
      completeCalls += 1;
    },
  });

  bootstrap.cancel();
  resolveResponse(Response.json(history("instance:late")));
  await bootstrap.done;
  assert.deepEqual(accepted, []);
  assert.deepEqual(states.map((state) => state.phase), ["loading"]);
  assert.equal(completeCalls, 0);
});

test("open trace sync pulls incremental host history and stops when closed", async () => {
  const calls = [];
  const accepted = [];
  const sync = startAgentTraceHistorySync({
    instanceIds: ["instance:live"],
    refreshIntervalMs: 250,
    fetchHistory: async (instanceId, options) => {
      calls.push(options.since || null);
      const next = calls.length === 1
        ? trace(instanceId, "event:initial", "2026-07-20T00:00:00.000Z")
        : trace(instanceId, "event:next", "2026-07-20T00:00:01.000Z");
      return historyResponse(instanceId, [next]);
    },
    onState: () => undefined,
    onEvents: recordEventIds(accepted),
  });

  await sync.firstDone;
  await waitFor(() => calls.length >= 2);
  assert.deepEqual(calls.slice(0, 2), [null, "2026-07-20T00:00:00.000Z"]);
  assert.deepEqual(accepted.slice(0, 2), ["event:initial", "event:next"]);

  sync.cancel();
  const stoppedAt = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.length, stoppedAt, "closing the detail must stop exact-host sync");
});

test("bounded planning cannot report complete when exact instances were omitted", async () => {
  let completed;
  const bootstrap = startAgentTraceHistoryBootstrap({
    instanceIds: ["instance:a", "instance:b", "instance:c"],
    maxInstances: 2,
    fetchHistory: async (instanceId) => Response.json(history(instanceId)),
    onState: () => undefined,
    onEvents: () => undefined,
    onComplete: (result) => {
      completed = result;
    },
  });
  await bootstrap.done;
  assert.equal(bootstrap.plan.omittedCount, 1);
  assert.equal(completed.complete, false);
  assert.deepEqual(completed.events.map((event) => event.id), ["event:instance:a", "event:instance:b"]);
});

test("invalid and timed-out host responses never deliver events", async () => {
  const states = [];
  const accepted = [];
  const invalid = startAgentTraceHistoryBootstrap({
    instanceIds: ["instance:invalid"],
    fetchHistory: async () => Response.json({
      availability: "unavailable",
      complete: true,
      events: [trace("instance:invalid")],
      cursor: null,
    }),
    onState: (state) => states.push(state),
    onEvents: (_instanceId, events) => accepted.push(...events),
  });
  await invalid.done;
  assert.equal(states.at(-1).phase, "error");
  assert.deepEqual(accepted, []);

  const timeoutStates = [];
  const timedOut = startAgentTraceHistoryBootstrap({
    instanceIds: ["instance:timeout"],
    timeoutMs: 5,
    fetchHistory: (_instanceId, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    onState: (state) => timeoutStates.push(state),
    onEvents: () => assert.fail("timed out history must not deliver events"),
  });
  await timedOut.done;
  assert.deepEqual(timeoutStates.at(-1), {
    instanceId: "instance:timeout",
    phase: "unavailable",
    complete: false,
    eventCount: 0,
    reason: "request_timeout",
  });
});

test("request planning and UI copy preserve bounded and non-complete host states", () => {
  const plan = planAgentTraceHistoryRequests(
    Array.from({ length: 20 }, (_, index) => `instance:${index}`).concat("instance:0")
  );
  assert.equal(plan.instanceIds.length, 16);
  assert.equal(plan.omittedCount, 4);

  const offline = agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "unavailable", complete: false, eventCount: 0, reason: "host_offline",
  });
  const timeout = agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "unavailable", complete: false, eventCount: 0, reason: "host_timeout",
  });
  const expired = agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "expired", complete: false, eventCount: 0,
  });
  const incomplete = agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "available", complete: false, eventCount: 3,
  });
  const accessDenied = agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "error", complete: false, eventCount: 0, reason: "trace_access_denied",
  });
  assert.equal(offline.title, "Agent host is offline");
  assert.equal(timeout.title, "Agent host timed out");
  assert.equal(expired.title, "Local trace retention expired");
  assert.equal(incomplete.title, "Only recent trace history is available");
  assert.equal(agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "available", complete: false, eventCount: 3, nextCursor: "t|e",
  }), null, "a loadable earlier page is not a gap to report");
  assert.equal(accessDenied.title, "You cannot view this trace");
  // An unavailable authority is an outage, not a denial, even though its code names access.
  assert.equal(agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "error", complete: false, eventCount: 0,
    reason: "postgres_trace_access_unavailable",
  }).title, "Agent host trace request failed");
  assert.equal(agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "error", complete: false, eventCount: 0, reason: "http_401",
  }).title, "Your session expired");
  assert.equal(agentTraceHistoryStatusCopy({
    instanceId: "i1", phase: "available", complete: true, eventCount: 3,
  }), null);
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a paged response carries its older cursor and is never complete while one remains", () => {
  const paged = parseAgentTraceHistoryResponse(
    history("instance:one", { nextCursor: "2026-07-20T00:00:00Z|event:1" }), "instance:one");
  assert.equal(paged.nextCursor, "2026-07-20T00:00:00Z|event:1");
  assert.equal(paged.complete, false, "a host claiming completeness with an older page is not trusted");
  assert.equal(parseAgentTraceHistoryResponse(history("instance:one"), "instance:one").nextCursor, null,
    "a Hub that predates paging sends no cursor");
  for (const nextCursor of [7, "", "x".repeat(241)]) {
    assert.throws(() => parseAgentTraceHistoryResponse(history("instance:one", { nextCursor }), "instance:one"),
      /cursor is invalid/);
  }
});

test("load earlier reads the page before the cursor without disturbing live sync", async () => {
  const calls = [];
  const states = [];
  const accepted = [];
  const sync = startAgentTraceHistorySync({
    instanceIds: ["instance:one"],
    refreshIntervalMs: 60_000,
    fetchHistory: async (instanceId, options) => {
      calls.push({ since: options.since || null, before: options.before || null });
      if (options.before === "2026-07-20T00:00:02Z|event:2") {
        return historyResponse(instanceId, [traceAtSecond(instanceId, "event:1", 1)], {
          complete: true,
          nextCursor: null,
        });
      }
      return historyResponse(instanceId, [traceAtSecond(instanceId, "event:2", 2)], {
        complete: false,
        nextCursor: "2026-07-20T00:00:02Z|event:2",
      });
    },
    onState: (state) => states.push(state),
    onEvents: recordEventIds(accepted),
  });
  await sync.firstDone;
  assert.equal(states.at(-1).nextCursor, "2026-07-20T00:00:02Z|event:2");
  assert.equal(agentTraceHistoryStatusCopy(states.at(-1)), null);

  const [older, joined] = await Promise.all([
    sync.loadOlder("instance:one", states.at(-1).nextCursor),
    sync.loadOlder("instance:one", states.at(-1).nextCursor),
  ]);
  assert.deepEqual(older, { phase: "available", nextCursor: null, complete: true, eventCount: 1 });
  assert.deepEqual(joined, older, "a double click joins the in-flight read");
  assert.deepEqual(accepted, ["event:2", "event:1"]);
  assert.deepEqual(calls, [
    { since: null, before: null },
    { since: null, before: "2026-07-20T00:00:02Z|event:2" },
  ]);
  sync.cancel();
});

test("a live delta larger than one page follows its cursor instead of leaving a hole", async () => {
  const calls = [];
  const accepted = [];
  const sync = startAgentTraceHistorySync({
    instanceIds: ["instance:one"],
    refreshIntervalMs: 250,
    fetchHistory: async (instanceId, options) => {
      calls.push({ since: options.since || null, before: options.before || null });
      if (!options.since) {
        return historyResponse(instanceId, [traceAtSecond(instanceId, "event:0", 0)]);
      }
      if (!options.before) {
        return historyResponse(instanceId, [traceAtSecond(instanceId, "event:9", 9)], {
          complete: false,
          nextCursor: "2026-07-20T00:00:09Z|event:9",
        });
      }
      return historyResponse(instanceId, [], { complete: true, nextCursor: null });
    },
    onState: () => undefined,
    onEvents: recordEventIds(accepted),
  });
  await sync.firstDone;
  await waitFor(() => calls.length >= 3);
  sync.cancel();
  assert.deepEqual(calls.slice(0, 3), [
    { since: null, before: null },
    { since: "2026-07-20T00:00:00Z", before: null },
    { since: "2026-07-20T00:00:00Z", before: "2026-07-20T00:00:09Z|event:9" },
  ]);
  assert.deepEqual(accepted.slice(0, 2), ["event:0", "event:9"]);
});

test("a host that cannot page reports why instead of repeating its newest page", async () => {
  const sync = startAgentTraceHistorySync({
    instanceIds: ["instance:one"],
    refreshIntervalMs: 60_000,
    fetchHistory: async (instanceId, options) => Response.json(options.before
      ? history(instanceId, { events: [], complete: false, reason: "host_paging_unsupported" })
      : history(instanceId, { complete: false, nextCursor: "2026-07-20T00:00:00Z|event:x" })),
    onState: () => undefined,
    onEvents: () => undefined,
  });
  await sync.firstDone;
  const result = await sync.loadOlder("instance:one", "2026-07-20T00:00:00Z|event:x");
  sync.cancel();
  assert.deepEqual(result, { phase: "error", reason: "host_paging_unsupported" });
  assert.match(agentTraceOlderPageErrorCopy(result), /xmatrix update/);
});

test("a transient failure after an authorized read keeps that history as stale, within a bound", () => {
  const shown = { instanceId: "i1", phase: "available", complete: false, eventCount: 3, nextCursor: "t|e" };
  const at = 1_000_000;
  for (const failure of [
    { phase: "unavailable", reason: "host_timeout" },
    { phase: "unavailable", reason: "host_overloaded" },
    { phase: "error", reason: "http_503" },
    { phase: "error", reason: "request_failed" },
  ]) {
    const held = holdAgentTraceReadThroughFailure(shown, { instanceId: "i1", complete: false, eventCount: 0, ...failure }, at);
    assert.equal(held.phase, "available", failure.reason);
    assert.equal(held.staleSince, at);
    // The panel keeps its own older-page cursor.
    assert.equal("nextCursor" in held, false);
    assert.equal(agentTraceHistoryStatusCopy(held), null);
  }
  const failure = { instanceId: "i1", phase: "unavailable", complete: false, eventCount: 0, reason: "host_timeout" };
  const stale = holdAgentTraceReadThroughFailure(shown, failure, at);
  assert.equal(holdAgentTraceReadThroughFailure(stale, failure, at + 29_999).staleSince, at,
    "the grace runs from the first failure, not the latest");
  assert.equal(holdAgentTraceReadThroughFailure(stale, failure, at + 30_000), null);
});

test("authorization failures, ended Runs, and reads with nothing shown are never held", () => {
  const shown = { instanceId: "i1", phase: "available", complete: true, eventCount: 3 };
  for (const next of [
    { phase: "error", reason: "trace_access_denied" },
    { phase: "error", reason: "http_401" },
    { phase: "error", reason: "http_403" },
    { phase: "expired", reason: "host_expired" },
    { phase: "available" },
  ]) {
    assert.equal(holdAgentTraceReadThroughFailure(shown, { instanceId: "i1", complete: false, eventCount: 0, ...next }, 1), null);
  }
  const failure = { instanceId: "i1", phase: "unavailable", complete: false, eventCount: 0, reason: "host_timeout" };
  assert.equal(holdAgentTraceReadThroughFailure(undefined, failure, 1), null);
  assert.equal(holdAgentTraceReadThroughFailure({ ...shown, phase: "loading" }, failure, 1), null);
});

test("the head read asks for a short page while deltas keep the full bound", async () => {
  const limits = [];
  const sync = startAgentTraceHistorySync({
    instanceIds: ["instance:one"],
    refreshIntervalMs: 250,
    headLimit: 100,
    fetchHistory: async (instanceId, options) => {
      limits.push({ since: Boolean(options.since), limit: options.limit });
      return Response.json(history(instanceId));
    },
    onState: () => undefined,
    onEvents: () => undefined,
  });
  await sync.firstDone;
  await waitFor(() => limits.length >= 2);
  sync.cancel();
  assert.deepEqual(limits.slice(0, 2), [{ since: false, limit: 100 }, { since: true, limit: 500 }]);
  assert.throws(() => startAgentTraceHistoryBootstrap({
    instanceIds: ["instance:one"], fetchHistory: async () => Response.json({}), headLimit: 501,
    onState: () => undefined, onEvents: () => undefined,
  }), /limit is invalid/);
});

async function waitForTraceReads(sync, reads, minimum) {
  await sync.firstDone;
  await waitFor(() => reads.length >= minimum);
}

test("a live delta long-polls the host and asks again as soon as it answers", async () => {
  const reads = [];
  let step = 1;
  const sync = startAgentTraceHistorySync({
    instanceIds: ["instance:one"],
    refreshIntervalMs: 60_000,
    waitMs: 400,
    fetchHistory: async (instanceId, options) => {
      reads.push({ since: options.since || null, waitMs: options.waitMs || null });
      if (!options.since) return historyResponse(instanceId, [traceAtSecond(instanceId, "event:0", 0)]);
      // The host holds the read until its next step lands.
      await new Promise((resolve) => setTimeout(resolve, 30));
      step += 1;
      return historyResponse(instanceId, [traceAtSecond(instanceId, `event:${step}`, step)]);
    },
    onState: () => undefined,
    onEvents: () => undefined,
  });
  await waitForTraceReads(sync, reads, 4);
  sync.cancel();
  assert.deepEqual(reads[0], { since: null, waitMs: null }, "the head read never waits");
  assert.deepEqual(reads.slice(1, 4).map((read) => read.waitMs), [400, 400, 400]);
  assert.equal(reads[2].since, "2026-07-20T00:00:02Z", "each read resumes from the newest step");
});

test("a host that cannot wait falls back to the refresh interval", async (t) => {
  // Keep an immediate empty answer below the half-wait threshold even when
  // the test worker is descheduled. Advance the fallback deadline explicitly.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const reads = [];
  const sync = startAgentTraceHistorySync({
    instanceIds: ["instance:one"],
    refreshIntervalMs: 60_000,
    waitMs: 400,
    fetchHistory: async (instanceId, options) => {
      reads.push(options.since || null);
      return historyResponse(instanceId, options.since ? [] : [trace(instanceId)]);
    },
    onState: () => undefined,
    onEvents: () => undefined,
  });
  t.after(() => sync.cancel());
  await sync.firstDone;
  t.mock.timers.tick(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 2, "an empty answer before half the wait is not a held read");
  t.mock.timers.tick(59_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 2, "the fallback waits for the full refresh interval");
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 3, "the next read starts at the refresh deadline");
});

test("one instance holding its read open does not delay another instance", async () => {
  const reads = { "instance:slow": 0, "instance:fast": 0 };
  let releaseSlow;
  const slowHeld = new Promise((resolve) => { releaseSlow = resolve; });
  const sync = startAgentTraceHistorySync({
    instanceIds: ["instance:slow", "instance:fast"],
    refreshIntervalMs: 60_000,
    waitMs: 400,
    fetchHistory: async (instanceId, options) => {
      reads[instanceId] += 1;
      if (!options.since) return historyResponse(instanceId, [traceAtSecond(instanceId, `${instanceId}:0`, 0)]);
      if (instanceId === "instance:slow") {
        await slowHeld;
        return historyResponse(instanceId, []);
      }
      const n = reads[instanceId];
      return historyResponse(instanceId, [traceAtSecond(instanceId, `${instanceId}:${n}`, n)]);
    },
    onState: () => undefined,
    onEvents: () => undefined,
  });
  await sync.firstDone;
  await waitFor(() => reads["instance:fast"] >= 4);
  assert.equal(reads["instance:slow"], 2, "the slow host is still holding its first live read");
  sync.cancel();
  releaseSlow();
});
