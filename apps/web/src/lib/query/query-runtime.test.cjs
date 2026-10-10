const assert = require("node:assert/strict");
const test = require("node:test");

const { QueryClient } = require("@tanstack/react-query");
const { installTypeScriptRequire } = require("../../components/dashboard/typescript-require.cjs");

installTypeScriptRequire();

const {
  XMatrixApiError,
  xmatrixApiRequest,
  requireJson,
  requireField,
  shouldRetryXMatrixQuery,
  xmatrixQueryRawResponse,
} = require("./api-client.ts");

test("a dropped JSON body retries as transport failure, including compatibility readers", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const [read, expected] of [
    [(signal) => xmatrixApiRequest({ url: "/spaces", signal }), { spaces: ["space-1"] }],
    [async () => requireJson(await fetch("/spaces")), { spaces: ["space-1"] }],
    [async () => requireField(await fetch("/spaces"), "spaces", "Spaces"), ["space-1"]],
  ]) {
    const client = new QueryClient({ defaultOptions: { queries: {
      retry: shouldRetryXMatrixQuery, retryDelay: 0,
    } } });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"spaces":'));
          controller.error(new TypeError("Load failed"));
        },
      }));
      return Response.json({ spaces: ["space-1"] });
    };
    try {
      const result = await client.fetchQuery({
        queryKey: ["body-drop"], queryFn: ({ signal }) => read(signal),
      });
      assert.deepEqual(result, expected);
      assert.equal(calls, 2);
    } finally { client.clear(); }
  }
});

test("JSON body classification preserves malformed JSON, locked bodies and caller cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("not json");
  await assert.rejects(xmatrixApiRequest({ url: "/spaces" }), SyntaxError);
  const locked = Response.json({ spaces: [] });
  locked.body.getReader();
  await assert.rejects(requireJson(locked), (error) => error instanceof TypeError && !(error instanceof XMatrixApiError));
  const controller = new AbortController();
  const cancellation = new DOMException("caller cancelled", "AbortError");
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(body) { controller.abort(cancellation); body.error(cancellation); },
  }));
  await assert.rejects(xmatrixApiRequest({ url: "/spaces", signal: controller.signal }), (error) => error === cancellation);
});

test("invalid successful JSON reports a safe parser stack and bounded response facts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const [body, media, expected] of [
    [null, undefined, "empty; media=missing"],
    ["<html>private-account-token</html>", "text/html", "nonempty; media=html"],
    ['{"private-account-token":', "application/json", "nonempty; media=json"],
  ]) {
    globalThis.fetch = async () => new Response(body, { headers: media ? { "content-type": media } : {} });
    await assert.rejects(xmatrixApiRequest({ url: "/transfers" }), (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.equal(error.message, `Invalid JSON response (HTTP 200; ${expected})`);
      assert.match(error.stack, /\n\s+at /);
      assert.doesNotMatch(error.stack, /private-account-token/);
      assert.equal(shouldRetryXMatrixQuery(0, error), false, "malformed JSON is still a defect");
      return true;
    });
  }
});

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

test("an aborted caller stops waiting without failing the shared query for others", async () => {
  const { untilCallerAborts } = require("./caller-abort.ts");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let release;
  let sharedSignal;
  const options = {
    queryKey: ["xmatrix", "hub", "user-1", "http-query", "transfers"],
    queryFn: async ({ signal }) => {
      sharedSignal = signal;
      await new Promise((resolve) => { release = resolve; });
      return "proposals";
    },
  };
  const leaving = new AbortController();
  const left = untilCallerAborts(client.fetchQuery(options), leaving.signal);
  const right = untilCallerAborts(client.fetchQuery(options), new AbortController().signal);
  leaving.abort();
  await assert.rejects(left, { name: "AbortError" });
  release();
  assert.equal(await right, "proposals");
  assert.equal(sharedSignal.aborted, false);
  client.clear();
});
