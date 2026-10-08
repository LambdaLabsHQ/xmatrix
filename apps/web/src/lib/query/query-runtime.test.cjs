const assert = require("node:assert/strict");
const test = require("node:test");

const { QueryClient } = require("@tanstack/react-query");
const { installTypeScriptRequire } = require("../../components/dashboard/typescript-require.cjs");

installTypeScriptRequire();

const {
  XMatrixApiError,
  shouldRetryXMatrixQuery,
  xmatrixQueryRawResponse,
} = require("./api-client.ts");

test("same-key subscribers share one in-flight query", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const options = {
    queryKey: ["xmatrix", "hub", "user-1", "catalog", "space-1"],
    queryFn: async () => {
      calls += 1;
      await pending;
      return { channels: ["channel-1"] };
    },
  };

  const left = client.fetchQuery(options);
  const right = client.fetchQuery(options);
  release();

  assert.deepEqual(await Promise.all([left, right]), [
    { channels: ["channel-1"] },
    { channels: ["channel-1"] },
  ]);
  assert.equal(calls, 1);
  client.clear();
});

test("retry policy is bounded to transient failures", () => {
  assert.equal(shouldRetryXMatrixQuery(0, new XMatrixApiError({ status: 408, message: "timeout" })), true);
  assert.equal(shouldRetryXMatrixQuery(1, new XMatrixApiError({ status: 429, message: "busy" })), true);
  assert.equal(shouldRetryXMatrixQuery(0, new XMatrixApiError({
    status: 503, message: "retry", retryable: true,
  })), true);
  assert.equal(shouldRetryXMatrixQuery(0, new XMatrixApiError({ status: 503, message: "stop" })), false);
  assert.equal(shouldRetryXMatrixQuery(0, new XMatrixApiError({ status: 426, message: "upgrade" })), false);
  assert.equal(shouldRetryXMatrixQuery(2, new XMatrixApiError({ status: 408, message: "timeout" })), false);
});

test("Query retries an explicitly retryable failure twice and then succeeds", async () => {
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: shouldRetryXMatrixQuery,
    retryDelay: 0,
  } } });
  let calls = 0;
  const value = await client.fetchQuery({
    queryKey: ["xmatrix", "hub", "user-1", "retry"],
    queryFn: async () => {
      calls += 1;
      if (calls < 3) throw new XMatrixApiError({
        status: 503, message: "temporary", retryable: true,
      });
      return "ready";
    },
  });
  assert.equal(value, "ready");
  assert.equal(calls, 3);
  client.clear();
});

test("raw compatibility reads expose retryable HTTP failures to Query", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response(JSON.stringify({
      error: "temporary", code: "temporary", retryable: true,
    }), { status: 503, headers: { "content-type": "application/json" } });
    return new Response("ready", { status: 200 });
  };
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: shouldRetryXMatrixQuery,
    retryDelay: 0,
  } } });
  try {
    const response = await client.fetchQuery({
      queryKey: ["xmatrix", "hub", "user-1", "raw-retry"],
      queryFn: () => xmatrixQueryRawResponse("/raw-retry"),
    });
    assert.equal(await response.text(), "ready");
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    client.clear();
  }
});

test("different user keys never coalesce", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let calls = 0;
  const queryFn = async () => ++calls;
  await Promise.all([
    client.fetchQuery({ queryKey: ["xmatrix", "hub", "user-1", "spaces"], queryFn }),
    client.fetchQuery({ queryKey: ["xmatrix", "hub", "user-2", "spaces"], queryFn }),
  ]);
  assert.equal(calls, 2);
  client.clear();
});

test("cancelQueries aborts the Query-owned request signal", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let observedSignal;
  const pending = client.fetchQuery({
    queryKey: ["xmatrix", "hub", "user-1", "abort"],
    queryFn: ({ signal }) => new Promise((resolve) => {
      observedSignal = signal;
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    }),
  });
  await client.cancelQueries({ queryKey: ["xmatrix", "hub", "user-1", "abort"] });
  assert.equal(observedSignal.aborted, true);
  await assert.rejects(pending, (error) => error?.message === "CancelledError");
  client.clear();
});

test("one transient rule: no answer, slow down, or the Hub's own label", async () => {
  const { isTransientFailure, errorFromResponse, xmatrixRetryDelayMs, xmatrixRawResponse } = require("./api-client.ts");
  const hub = (status, body, headers) => new Response(JSON.stringify(body), { status, headers });
  assert.equal(isTransientFailure(await errorFromResponse(hub(503, { error: "x", code: "service_restarting", retryable: true }))), true);
  assert.equal(isTransientFailure(await errorFromResponse(hub(500, { error: "x", code: "internal_error", retryable: false }))), false);
  assert.equal(isTransientFailure(await errorFromResponse(new Response("<html>", { status: 502 }))), true, "a gateway page never reached the Hub");
  assert.equal(isTransientFailure(await errorFromResponse(new Response("", { status: 500 }))), false);
  assert.equal(isTransientFailure(new TypeError("x is not a function")), false);

  const paced = await errorFromResponse(hub(503, { error: "x", code: "postgres_unavailable", retryable: true }, { "retry-after": "4" }));
  assert.equal(xmatrixRetryDelayMs(0, paced), 4_000, "the server's pace wins");
  const delay = xmatrixRetryDelayMs(2, new XMatrixApiError({ status: 0, message: "x" }));
  assert.ok(delay >= 2_000 && delay <= 4_000, `jittered backoff, got ${delay}`);

  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(xmatrixRawResponse("/x"), (error) => error.status === 0 && isTransientFailure(error));
    const deadline = new AbortController();
    deadline.abort(new DOMException("caller deadline", "TimeoutError"));
    globalThis.fetch = async (_input, init) => { throw init.signal.reason; };
    await assert.rejects(xmatrixRawResponse("/x", { signal: deadline.signal }),
      (error) => error.name === "TimeoutError", "the caller's own deadline passes through unchanged");
  } finally {
    globalThis.fetch = original;
  }
});
