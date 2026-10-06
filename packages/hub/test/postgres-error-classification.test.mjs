import assert from "node:assert/strict";
import test from "node:test";

import {
  postgresRetryAfterSeconds,
  retryablePostgresFailure,
} from "../src/postgres-error-classification.ts";
import { postgresMessageErrorResponse } from "../src/postgres-message-authority.ts";

test("deterministic PostgreSQL SQL and schema defects are non-retryable", async () => {
  for (const code of ["42P18", "42601", "42703", "42P01"]) {
    assert.equal(retryablePostgresFailure(Object.assign(new Error("SQL failed"), { code })), false);
  }
  assert.equal(retryablePostgresFailure(new Error("unknown program failure")), false);
  const response = postgresMessageErrorResponse(
    Object.assign(new Error("could not determine data type of parameter $4"), { code: "42P18" }));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("retry-after"), null);
});

test("only evidenced PostgreSQL connection, serialization, and timeout failures retry", () => {
  for (const error of [
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    Object.assign(new Error("connection failure"), { code: "08006" }),
    Object.assign(new Error("serialization failure"), { code: "40001" }),
    Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
    Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
  ]) assert.equal(retryablePostgresFailure(error), true);
  assert.equal(retryablePostgresFailure(
    Object.assign(new Error("canceling statement due to user request"), { code: "57014" }),
  ), false);
});

test("pg's exact code-less transport failures retry without masking explicit SQLSTATE", () => {
  for (const message of [
    "Query read timeout",
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
  ]) {
    assert.equal(retryablePostgresFailure(new Error(message)), true);
    for (const code of ["42P18", "42501", "XX000"]) {
      assert.equal(retryablePostgresFailure(Object.assign(new Error(message), { code })), false);
    }
  }
  for (const message of ["Connection terminated", "SQL query timeout defect", "Query read timeout: bad SQL"]) {
    assert.equal(retryablePostgresFailure(new Error(message)), false);
  }
});

test("a pg-pool connect timeout answers unavailable", async () => {
  const response = postgresMessageErrorResponse(new Error("timeout exceeded when trying to connect"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).retryable, true);
});

test("an open shard breaker answers unavailable with its cooldown as Retry-After", async () => {
  const open = Object.assign(new Error("PostgreSQL shard is temporarily unavailable"),
    { code: "database_circuit_open", retryAfterMs: 4_200 });
  assert.equal(retryablePostgresFailure(open), true);
  assert.equal(postgresRetryAfterSeconds(open), 5);
  assert.equal(postgresRetryAfterSeconds(Object.assign(new Error("x"), { retryAfterMs: 120_000 })), 30);
  assert.equal(postgresRetryAfterSeconds(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), 2);
  const unavailable = postgresMessageErrorResponse(open);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "5");
  const internal = postgresMessageErrorResponse(Object.assign(new Error("bad"), { code: "42703" }));
  assert.equal(internal.status, 500);
  assert.equal(internal.headers.get("retry-after"), null, "a defect is not worth retrying");
});
