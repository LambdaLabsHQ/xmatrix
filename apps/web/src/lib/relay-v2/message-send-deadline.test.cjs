const assert = require("node:assert/strict");
const test = require("node:test");

async function load() {
  return await import("./message-send-deadline.ts");
}

/** The real retry policy shape: it must honour the signal it is handed. */
function passthroughRetry(attempt, options) {
  if (options.signal.aborted) return Promise.reject(options.signal.reason);
  return attempt();
}

function untilAborted(signal) {
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
}

async function appendWithDefaultRetry(send, deadlineMs = 20) {
  const { performBoundedMessageAppend } = await load();
  return performBoundedMessageAppend({ deadlineMs, withRetry: passthroughRetry, send });
}

test("a request that never answers is unconfirmed, not failed", async () => {
  const outcome = await appendWithDefaultRetry((signal) => untilAborted(signal));
  assert.deepEqual(outcome, { kind: "unconfirmed" });
});

test("a 2xx whose body stalls is unconfirmed", async () => {
  const outcome = await appendWithDefaultRetry(async (signal) => ({
      ok: true,
      status: 200,
      json: () => untilAborted(signal),
    }));
  assert.deepEqual(
    outcome,
    { kind: "unconfirmed" },
    "the server accepted it but never finished answering: the result is unknown",
  );
});

test("a 4xx whose error body stalls is a determinate failure", async () => {
  const outcome = await appendWithDefaultRetry(async (signal) => ({
      ok: false,
      status: 400,
      json: () => untilAborted(signal),
    }));
  assert.equal(
    outcome.kind,
    "failed",
    "a non-2xx already decided the outcome; a stalled error body must fail fast",
  );
});

test("a deadline starts no further retry attempt", async () => {
  const { performBoundedMessageAppend } = await load();
  let attempts = 0;
  const outcome = await performBoundedMessageAppend({
    deadlineMs: 20,
    // A policy that keeps retrying, with backoff, unless the signal stops it.
    // The backoff matters: without it the sequence would exhaust before the
    // deadline could ever land, and the test would prove nothing.
    withRetry: async (attempt, options) => {
      for (let round = 0; round < 5; round += 1) {
        if (options.signal.aborted) throw options.signal.reason;
        try {
          return await attempt();
        } catch (error) {
          if (options.signal.aborted) throw options.signal.reason;
          if (round === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      throw new Error("unreachable");
    },
    send: async (signal) => {
      attempts += 1;
      if (signal.aborted) throw signal.reason;
      throw new Error("transient");
    },
  });
  assert.deepEqual(outcome, { kind: "unconfirmed" });
  const settled = attempts;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(attempts, settled, "no attempt may start after the deadline expired");
});

test("a committed append returns its payload", async () => {
  const outcome = await appendWithDefaultRetry(async () => ({ ok: true, status: 200, json: async () => ({ message: { id: "m1" } }) }), 200);
  assert.equal(outcome.kind, "committed");
  assert.deepEqual(outcome.payload, { message: { id: "m1" } });
});

test("a 4xx with a readable body reports the server's reason", async () => {
  const outcome = await appendWithDefaultRetry(async () => ({ ok: false, status: 403, json: async () => ({ error: "not a member", code: "forbidden", retryable: false }) }), 200);
  assert.deepEqual(outcome, { kind: "failed", status: 403, message: "not a member", code: "forbidden", retryable: false });
});

test("retries exhausted by network failures leave the result unknown", async () => {
  const { performBoundedMessageAppend } = await load();
  // Every attempt lost its response. The shared clientMessageId makes retrying
  // safe, but nothing here proves the POST failed to commit.
  let attempts = 0;
  const outcome = await performBoundedMessageAppend({
    deadlineMs: 500,
    withRetry: async (attempt) => {
      for (let round = 0; round < 3; round += 1) {
        try {
          return await attempt();
        } catch (error) {
          if (round === 2) throw error;
        }
      }
      throw new Error("unreachable");
    },
    send: async () => {
      attempts += 1;
      throw new TypeError("network error");
    },
  });
  assert.deepEqual(outcome, { kind: "unconfirmed" });
  assert.equal(attempts, 3, "it exhausted its attempts rather than timing out");
});

test("a 2xx with an unparseable body is still committed", async () => {
  // The headers already decided success; an empty or non-JSON body does not
  // undo that, and reporting it as failed would contradict the server.
  const outcome = await appendWithDefaultRetry(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
    }), 200);
  assert.deepEqual(outcome, { kind: "committed", payload: {} });
});
