import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIVE_DELIVERY_MAX_ATTEMPTS,
  LIVE_DELIVERY_RETRY_DELAYS_MS,
  LiveDeliveryRejectedError,
  isRetriableLiveDeliveryFailure,
  publishWithLiveDeliveryRetry,
} from "../src/relay-authority-live-delivery-retry.ts";

/** The exact platform rejection that motivated the retry policy. */
const OVERLOAD = "Durable Object is overloaded. Requests queued for too long.";

/** Records the delays instead of waiting them out. */
function recordingSleep() {
  const delays = [];
  return { delays, sleep: (ms) => { delays.push(ms); return Promise.resolve(); } };
}

async function deliveredAfter(successAttempt) {
  const { delays, sleep } = recordingSleep();
  let attempts = 0;
  const result = await publishWithLiveDeliveryRetry(() => {
    attempts += 1;
    if (attempts < successAttempt) return Promise.reject(new Error(OVERLOAD));
    return Promise.resolve("delivered");
  }, { sleep });
  return { result, attempts, delays };
}

test("the retry budget is bounded and every attempt but the last has a delay", () => {
  assert.equal(LIVE_DELIVERY_MAX_ATTEMPTS, 3);
  assert.equal(LIVE_DELIVERY_RETRY_DELAYS_MS.length, LIVE_DELIVERY_MAX_ATTEMPTS - 1);
  for (const delay of LIVE_DELIVERY_RETRY_DELAYS_MS) {
    assert.ok(Number.isSafeInteger(delay) && delay > 0, `delay ${delay} must be a positive integer`);
  }
});

test("only an overload rejection is replayable", () => {
  // Rejected before the object ran, so no socket can have received the message.
  assert.equal(isRetriableLiveDeliveryFailure(new Error(OVERLOAD)), true);
  assert.equal(isRetriableLiveDeliveryFailure(new Error("durable object is OVERLOADED")), true);

  // Relay Runtime broadcasts before it answers, so any answer it gives may
  // already have reached sockets. Replaying would deliver the message twice.
  for (const status of [400, 500, 503]) {
    assert.equal(
      isRetriableLiveDeliveryFailure(new LiveDeliveryRejectedError(status, `refused (${status})`)),
      false,
      `status ${status} must not be replayed`,
    );
  }
  // An unrecognized transport error is ambiguous, so it is not replayed either.
  assert.equal(isRetriableLiveDeliveryFailure(new Error("Network connection lost")), false);
  assert.equal(isRetriableLiveDeliveryFailure("some string"), false);
});

test("a first-attempt success publishes exactly once and never sleeps", async () => {
  const { result, attempts, delays } = await deliveredAfter(1);

  assert.equal(result, "delivered");
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test("an overloaded fanout is retried until it succeeds and the message is delivered", async () => {
  const { result, attempts, delays } = await deliveredAfter(3);

  assert.equal(result, "delivered");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [...LIVE_DELIVERY_RETRY_DELAYS_MS]);
});

test("a persistent overload stops at the budget and rethrows the last error", async () => {
  const { delays, sleep } = recordingSleep();
  const observed = [];
  let attempts = 0;

  await assert.rejects(
    publishWithLiveDeliveryRetry(() => {
      attempts += 1;
      return Promise.reject(new Error(`${OVERLOAD} attempt ${attempts}`));
    }, { sleep, onAttemptFailed: (attempt) => observed.push(attempt) }),
    /attempt 3/u,
  );

  assert.equal(attempts, LIVE_DELIVERY_MAX_ATTEMPTS);
  // No trailing sleep: the final failure must not hold the object open.
  assert.deepEqual(delays, [...LIVE_DELIVERY_RETRY_DELAYS_MS]);
  assert.deepEqual(observed, [1, 2, 3]);
});

test("a Runtime refusal is never replayed, so a broadcast is never duplicated", async () => {
  const { delays, sleep } = recordingSleep();
  let attempts = 0;

  await assert.rejects(
    publishWithLiveDeliveryRetry(() => {
      attempts += 1;
      return Promise.reject(new LiveDeliveryRejectedError(500, "RelayRuntime rejected (500)"));
    }, { sleep }),
    /RelayRuntime rejected \(500\)/u,
  );

  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});
