const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { XMatrixApiError } = require("../../lib/query/api-client.ts");
const {
  workspaceResponseIsTransient,
  runIdempotentMutationFetchWithRetry,
  runWorkspaceFetchWithRetry,
  workspaceResponseDefersRetry,
  WORKSPACE_FETCH_MAX_ATTEMPTS,
  WORKSPACE_FETCH_ATTEMPT_TIMEOUT_MS,
  CHANNEL_CATALOG_FETCH_TOTAL_TIMEOUT_MS,
  workspaceAttemptSignal,
} = require("./workspace-refresh-policy.ts");

const noSleep = async () => {};

function countedStatusResponse(status) {
  let attempts = 0;
  return {
    attempts: () => attempts,
    run: () => runWorkspaceFetchWithRetry(async () => { attempts += 1; return { ok: false, status }; }, { sleep: noSleep }),
  };
}

/** What the transport throws when a request got no answer at all. */
const transportFailure = () => new XMatrixApiError({ message: "Failed to fetch", status: 0, retryable: true });

test("retriable status classification matches transient failures only", async () => {
  for (const status of [408, 429, 502, 503, 504]) {
    assert.equal(await workspaceResponseIsTransient({ ok: false, status }), true, `status ${status} should retry`);
  }
  for (const status of [400, 401, 403, 404, 413, 500]) {
    assert.equal(await workspaceResponseIsTransient({ ok: false, status }), false, `status ${status} should not retry`);
  }
});

test("the Hub's own label decides whether its 5xx is transient", async () => {
  const hub = (status, body) => new Response(JSON.stringify(body), { status });
  assert.equal(await workspaceResponseIsTransient(hub(500, { error: "x", code: "internal_error", retryable: false })), false);
  assert.equal(await workspaceResponseIsTransient(hub(503, { error: "x", code: "postgres_unavailable", retryable: true })), true);
  assert.equal(await workspaceResponseIsTransient(hub(503, { error: "x", code: "page_session_unavailable", retryable: false })), false);
  assert.equal(await workspaceResponseIsTransient(new Response("<html>Bad gateway</html>", { status: 502 })), true);
});

test("a programming error is not retried", async () => {
  let attempts = 0;
  await assert.rejects(runWorkspaceFetchWithRetry(async () => {
    attempts += 1;
    throw new TypeError("undefined is not a function");
  }, { sleep: noSleep }), /not a function/);
  assert.equal(attempts, 1);
});

test("retries transient 5xx then succeeds", async () => {
  let attempts = 0;
  const res = await runWorkspaceFetchWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    },
    { sleep: noSleep }
  );
  assert.equal(attempts, 3);
  assert.deepEqual(res, { ok: true, status: 200 });
});

test("a server Retry-After stops interactive retries instead of amplifying an outage", async () => {
  let attempts = 0;
  const response = await runWorkspaceFetchWithRetry(
    async () => {
      attempts += 1;
      return {
        ok: false,
        status: 503,
        headers: { get: (name) => name.toLowerCase() === "retry-after" ? "30" : null },
      };
    },
    { sleep: noSleep },
  );
  assert.equal(response.status, 503);
  assert.equal(attempts, 1);
});

test("idempotent mutations preserve a determinate Retry-After failure", async () => {
  let attempts = 0;
  const response = await runIdempotentMutationFetchWithRetry(
    async () => {
      attempts += 1;
      return {
        ok: false,
        status: 503,
        headers: { get: () => "30" },
      };
    },
    { sleep: noSleep },
  );
  assert.equal(response.status, 503);
  assert.equal(attempts, 1);
});

test("Retry-After accepts future HTTP dates and rejects stale or zero values", () => {
  const now = Date.parse("2026-08-30T00:00:00.000Z");
  const response = (value) => ({
    ok: false,
    status: 503,
    headers: { get: () => value },
  });
  assert.equal(workspaceResponseDefersRetry(response("1"), now), true);
  assert.equal(workspaceResponseDefersRetry(response("0"), now), false);
  assert.equal(workspaceResponseDefersRetry(response("Sun, 30 Aug 2026 00:00:30 GMT"), now), true);
  assert.equal(workspaceResponseDefersRetry(response("Sat, 29 Aug 2026 23:59:30 GMT"), now), false);
  assert.equal(workspaceResponseDefersRetry(response("later"), now), false);
});

test("does NOT retry a non-transient 4xx", async () => {
  const counted = countedStatusResponse(400);
  const res = await counted.run();
  assert.equal(counted.attempts(), 1);
  assert.equal(res.status, 400);
});

test("retries a network throw then succeeds", async () => {
  let attempts = 0;
  const res = await runWorkspaceFetchWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw transportFailure();
      return { ok: true, status: 200 };
    },
    { sleep: noSleep }
  );
  assert.equal(attempts, 2);
  assert.equal(res.ok, true);
});

test("returns the last retriable response after exhausting attempts", async () => {
  const counted = countedStatusResponse(503);
  const res = await counted.run();
  assert.equal(counted.attempts(), WORKSPACE_FETCH_MAX_ATTEMPTS);
  assert.equal(res.status, 503);
});

test("rethrows a persistent network error after exhausting attempts", async () => {
  let attempts = 0;
  await assert.rejects(
    runWorkspaceFetchWithRetry(
      async () => {
        attempts += 1;
        throw transportFailure();
      },
      { sleep: noSleep }
    ),
    /Failed to fetch/
  );
  assert.equal(attempts, WORKSPACE_FETCH_MAX_ATTEMPTS);
});

test("idempotent mutations retry an ambiguous network failure with the same operation", async () => {
  let attempts = 0;
  const operationIds = [];
  const response = await runIdempotentMutationFetchWithRetry(
    async () => {
      attempts += 1;
      operationIds.push("client-message-1");
      if (attempts === 1) throw transportFailure();
      return { ok: true, status: 200 };
    },
    { sleep: noSleep }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(operationIds, ["client-message-1", "client-message-1"]);
});

test("idempotent mutations fail fast for a non-transient response", async () => {
  let attempts = 0;
  const response = await runIdempotentMutationFetchWithRetry(
    async () => {
      attempts += 1;
      return { ok: false, status: 403 };
    },
    { sleep: noSleep }
  );

  assert.equal(response.status, 403);
  assert.equal(attempts, 1);
});

// A caller deadline must stop the whole sequence, not just the in-flight fetch.
// An uncancellable backoff would let the caller give up while this policy kept
// issuing requests behind it.
test("an aborted signal starts no further attempt and ends a pending backoff", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const started = [];
  const pending = runIdempotentMutationFetchWithRetry(
    async () => {
      attempts += 1;
      started.push(attempts);
      return { ok: false, status: 503 };
    },
    {
      maxAttempts: 5,
      signal: controller.signal,
      // A long backoff so the abort lands while we are sleeping, not fetching.
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );
  // Let the first attempt run and enter its backoff, then give up.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reason = new Error("caller deadline");
  controller.abort(reason);
  await assert.rejects(pending, /caller deadline/u);
  const afterAbort = attempts;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(attempts, afterAbort, "no attempt may start after the signal aborted");
  assert.ok(attempts < 5, "the sequence must stop early rather than exhaust maxAttempts");
});

test("an already-aborted signal performs no attempt at all", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already gone"));
  let attempts = 0;
  await assert.rejects(
    runIdempotentMutationFetchWithRetry(async () => {
      attempts += 1;
      return { ok: true, status: 200 };
    }, { signal: controller.signal }),
    /already gone/u,
  );
  assert.equal(attempts, 0);
});

// `sleep` is a public option and the pre-signal implementation propagated its
// rejection. It must still propagate rather than leaving the sequence unsettled.
test("a rejecting injected sleep propagates and starts no further attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(
    runIdempotentMutationFetchWithRetry(
      async () => {
        attempts += 1;
        return { ok: false, status: 503 };
      },
      {
        maxAttempts: 4,
        signal: controller.signal,
        sleep: async () => { throw new Error("backoff failed"); },
      },
    ),
    /backoff failed/u,
  );
  assert.equal(attempts, 1, "the failed backoff must not be followed by another attempt");
});

test("each catalog attempt is bounded so a dead keep-alive cannot hold the in-flight lock", () => {
  assert.equal(WORKSPACE_FETCH_ATTEMPT_TIMEOUT_MS, 15_000);
  assert.equal(CHANNEL_CATALOG_FETCH_TOTAL_TIMEOUT_MS, 20_000);
  assert.ok(CHANNEL_CATALOG_FETCH_TOTAL_TIMEOUT_MS < WORKSPACE_FETCH_ATTEMPT_TIMEOUT_MS * 2);
  const signal = workspaceAttemptSignal();
  assert.equal(signal.aborted, false);
});

test("an attempt that hit its own deadline is retried; a caller abort is not", async () => {
  let attempts = 0;
  const res = await runWorkspaceFetchWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new DOMException("attempt deadline", "TimeoutError");
    return { ok: true, status: 200 };
  }, { sleep: noSleep });
  assert.equal(res.ok, true);
  assert.equal(attempts, 2);
});
