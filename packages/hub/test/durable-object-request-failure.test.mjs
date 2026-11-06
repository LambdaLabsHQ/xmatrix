import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { requestErrorResponse } from "../src/index-shared.ts";
import { transientFailure } from "../src/error-contract.ts";
import { sentryEventMetadata } from "../src/connectors/actions/sentry-event-metadata.ts";
import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";
import { routeDomainSocket } from "../src/runtime-transport/domain-socket-route.ts";
import { RELAY_RUNTIME_CELL_HEADER } from "../src/runtime-transport/runtime-cell-locator.ts";

// HUB-B5: a stackless platform exception reached the shared HTTP boundary,
// whose console report discarded the route. Existing status-only coverage
// cannot protect the evidence needed to locate the failed operation.
test("DO failures retain each HTTP route and platform flags in one readable report", async t => {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  const app = new Hono();
  app.onError((error, c) => requestErrorResponse(c, error));
  let executed = 0;
  const failures = [
    Object.assign(new Error("Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request."), { retryable: true }),
    Object.assign(new Error("Durable Object is overloaded."), { overloaded: true }),
    Object.assign(new Error("Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request."), { retryable: true }),
  ];
  failures[0].stack = undefined;
  failures[2].stack = undefined;
  failures[1].stack = "Error: Durable Object is overloaded.\n    at originalDelivery (index.js:123:4)";
  for (const [index, path] of ["/api/channels/:channelId/messages", "/api/spaces/:spaceId/pages/:pageId", "/api/relay-v2/private-r2"].entries()) {
    app.post(path, async () => { executed++; await Promise.resolve(); throw failures[index]; });
  }
  const responses = await Promise.all([
    app.request("/api/channels/private-channel/messages?secret=private-query", {
      method: "POST", body: "private-body", headers: { authorization: "private-token" },
    }),
    app.request("/api/spaces/private-space/pages/private-page", { method: "POST" }),
    app.request("/api/relay-v2/private-r2", { method: "POST" }),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { error: "xMatrix is restarting; try again",
      code: "service_restarting", retryable: true });
  }
  assert.equal(executed, 3, "reporting never replays work that may have committed");
  await sendErrorReports();
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, 3, "no duplicate console events or deduplication across different routes");
  const lines = events.flatMap(event => sentryEventMetadata({ context: event.extra, tags: Object.entries(event.tags)
    .map(([key, value]) => ({ key, value })) }));
  assert.ok(lines.includes("Durable Object failure: POST /api/channels/:channelId/messages · retryable=true · overloaded=false"));
  assert.ok(lines.includes("Durable Object failure: POST /api/spaces/:spaceId/pages/:pageId · retryable=false · overloaded=true"));
  assert.ok(lines.includes("Durable Object failure: POST /api/relay-v2/private-r2 · retryable=true · overloaded=false"));
  assert.doesNotMatch(JSON.stringify(events.map(event => event.extra)), /private-(?:channel|space|page|query|body|token)|authorization|secret|body/u);
  const stackless = events.find(event => event.exception.values[0].value === failures[0].message).exception.values[0];
  assert.equal(stackless.mechanism.data.stack_origin, "capture_boundary");
  assert.ok(stackless.stacktrace.frames.length > 0);
  assert.ok(events.some(event => event.exception.values[0].stacktrace.frames.some(frame => frame.function === "originalDelivery")));
  assert.equal(failures[0].stack, undefined, "reporting does not invent an originating stack");
});

test("non-HTTP DO failures retain their fixed boundary and unknown callers stay unavailable", async t => {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  for (const operation of ["PageSession.fetch", "HarnessReleaseWatch.runtime", "private-operation"]) {
    const error = Object.assign(new Error("Network connection lost."), { retryable: true, overloaded: "private-flag" });
    assert.equal(transientFailure(error, () => ({ operation, ids: { userId: "private-user" } })).status, 503);
  }
  await sendErrorReports();
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, 3);
  const lines = events.flatMap(event => sentryEventMetadata({ context: event.extra }));
  for (const operation of ["PageSession.fetch", "HarnessReleaseWatch.runtime", "unavailable"]) {
    assert.ok(lines.includes(`Durable Object failure: ${operation} · retryable=true · overloaded=false`));
  }
  assert.doesNotMatch(JSON.stringify(events.map(event => event.extra)), /private-/u);
});

test("DO issue metadata rejects malformed or private diagnostic fields", () => {
  const valid = { operation: "POST /api/channels/:channelId/messages", retryable: true, overloaded: false };
  for (const value of [null, "{", JSON.stringify(null), JSON.stringify({ ...valid, body: "private-body" }),
    JSON.stringify({ ...valid, operation: "POST https://private.example/path?token=private-token" }),
    JSON.stringify({ ...valid, operation: "POST /api/channels/12345678-1234-1234-1234-123456789abc" }),
    JSON.stringify({ ...valid, retryable: "private-flag" }), "x".repeat(1025)]) {
    assert.deepEqual(sentryEventMetadata({ context: { durable_object_failure: value } }), []);
  }
});

// HUB-BS/BT: the HTTP report already names the route, but cannot distinguish
// an immediate platform refusal from time spent waiting for the Runtime cell.
// Exercise the real router through reporting and the Sentry reader, not a logger mock.
test("socket overloads retain fetch duration and routing kind without replaying or exposing the owner", async t => {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  let now = 1000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const cases = [
    { path: "/ws/agent-instances", cell: "owner", delay: 3250, duration: 3250, remote: false, reason: "internal",
      message: "internal error; reference = privateplatformreference" },
    { path: "/ws/machine-daemons", cell: "unassigned", delay: 0, duration: 0, remote: true, reason: "queue_age",
      message: "Durable Object is overloaded. Requests queued for too long." },
    { path: "/ws/humans", cell: "owner", delay: 250000, duration: 120000, remote: "private-flag", reason: "other",
      message: "private-message" },
  ];
  for (const item of cases) {
    const app = new Hono();
    app.onError((error, c) => requestErrorResponse(c, error));
    const error = Object.assign(new Error(item.message), { overloaded: true, remote: item.remote });
    error.stack = undefined;
    Object.freeze(error);
    app.get(item.path, c => routeDomainSocket(c.req.raw, item.path, {
      fetch() {
        calls++; now += item.delay;
        if (item.cell === "owner") return Promise.reject(error);
        throw error;
      },
    }));
    const response = await app.request(`${item.path}?owner=private-owner&secret=private-query`, {
      headers: { [RELAY_RUNTIME_CELL_HEADER]: item.cell === "owner" ? "user-private-owner" : "invalid", authorization: "private-token" },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(error.stack, undefined);
  }
  await sendErrorReports();
  assert.equal(calls, cases.length, "overload is never replayed at the Worker");
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, cases.length, "annotation does not create a second report");
  const lines = events.flatMap(event => sentryEventMetadata({ context: event.extra }));
  for (const item of cases) {
    assert.ok(lines.includes(`Runtime socket fetch: cell=${item.cell} · durationMs=${item.duration} · remote=${typeof item.remote === "boolean" ? item.remote : "unavailable"} · reason=${item.reason}`), lines.join("\n"));
  }
  assert.doesNotMatch(JSON.stringify(events.map(event => event.extra)), /private|authorization|secret/u);
});

test("socket metadata rejects private fields, unknown kinds and unbounded duration", () => {
  const valid = { operation: "GET /ws/agent-instances", retryable: false, overloaded: true };
  const socket = { cell: "owner", durationMs: 3250, remote: false, reason: "internal" };
  for (const patch of [{ owner: "private-owner" }, { cell: "user-private-owner" }, { durationMs: -1 },
    { durationMs: 120001 }, { durationMs: 1.5 }, { remote: "private-flag" }, { reason: "private-message" }]) {
    assert.deepEqual(sentryEventMetadata({ context: { durable_object_failure: JSON.stringify({ ...valid, socket: { ...socket, ...patch } }) } }), []);
  }
});
