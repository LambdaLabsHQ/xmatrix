import assert from "node:assert/strict";
import test from "node:test";

import { requestErrorResponse, requestErrorStatus } from "../src/index-shared.ts";

/** An app whose every path answers its failure through requestErrorResponse. */
async function answering(failures) {
  const { Hono } = await import("hono");
  const app = new Hono();
  for (const [path, error] of Object.entries(failures)) app.get(path, (c) => requestErrorResponse(c, error));
  return app;
}

test("a PostgreSQL outage a replay can survive answers 503", () => {
  for (const code of ["ECONNRESET", "40001", "57P03"]) {
    assert.equal(requestErrorStatus(Object.assign(new Error("transient"), { code })), 503, code);
  }
});

test("a Hyperdrive checkout that timed out answers 503, not an internal 500", () => {
  assert.equal(requestErrorStatus(new Error("Connection terminated due to connection timeout", {
    cause: new Error("Connection terminated unexpectedly"),
  })), 503);
});

test("a deterministic PostgreSQL defect stays a 500, never an outage", () => {
  assert.equal(requestErrorStatus(Object.assign(new Error("duplicate key value violates unique constraint"),
    { code: "23505" })), 500);
  assert.equal(requestErrorStatus(Object.assign(new Error("column does not exist"), { code: "42703" })), 500);
});

test("route failures never echo a database's own message", async () => {
  const app = await answering({
    "/terminated": new Error("Connection terminated unexpectedly"),
    "/timeout": Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    "/defect": Object.assign(new Error('relation "secret_table" does not exist'), { code: "42P01" }),
  });
  for (const path of ["/terminated", "/timeout"]) {
    const response = await app.request(path);
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(),
      { error: "xMatrix is briefly unavailable; try again", code: "postgres_unavailable", retryable: true });
  }
  const defect = await app.request("/defect");
  assert.equal(defect.status, 500);
  assert.deepEqual(await defect.json(), { error: "Internal error", code: "internal_error", retryable: false });
});

test("a Durable Object reset or dropped by a deploy answers a retryable 503", async () => {
  const paths = ["/reset", "/lost", "/flagged", "/overloaded"];
  const app = await answering({
    "/reset": new Error("Durable Object reset because its code was updated."),
    "/lost": new Error("Network connection lost."),
    "/flagged": Object.assign(new Error("internal error"), { retryable: true }),
    "/overloaded": Object.assign(new Error("Durable Object is overloaded. Too many requests queued."), { overloaded: true }),
  });
  for (const path of paths) {
    const response = await app.request(path);
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("retry-after"), "1", path);
    assert.deepEqual(await response.json(),
      { error: "xMatrix is restarting; try again", code: "service_restarting", retryable: true }, path);
  }
});

test("a pg client that lost its connection answers 503", () => {
  for (const message of [
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
  ]) assert.equal(requestErrorStatus(new Error(message)), 503, message);
  assert.equal(requestErrorStatus(Object.assign(new Error("x"), { code: "CONNECTION_UNUSABLE" })), 503);
});
