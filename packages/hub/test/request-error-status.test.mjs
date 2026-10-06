import assert from "node:assert/strict";
import test from "node:test";

import { requestErrorResponse, requestErrorStatus } from "../src/index-shared.ts";

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
  const { Hono } = await import("hono");
  const app = new Hono();
  const failures = {
    "/terminated": new Error("Connection terminated unexpectedly"),
    "/timeout": Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    "/defect": Object.assign(new Error('relation "secret_table" does not exist'), { code: "42P01" }),
  };
  for (const [path, error] of Object.entries(failures)) {
    app.get(path, (c) => requestErrorResponse(c, error));
  }
  for (const path of ["/terminated", "/timeout"]) {
    const response = await app.request(path);
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(),
      { error: "PostgreSQL is unavailable", code: "postgres_unavailable", retryable: true });
  }
  const defect = await app.request("/defect");
  assert.equal(defect.status, 500);
  assert.deepEqual(await defect.json(), { error: "Internal error", code: "internal_error", retryable: false });
});
