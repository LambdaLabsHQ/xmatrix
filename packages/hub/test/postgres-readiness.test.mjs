import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import {
  POSTGRES_READINESS_PATH,
  registerIndexRoutesPostgresReadiness,
} from "../src/postgres-readiness.ts";

function appWith(dependencies) {
  const app = new Hono();
  registerIndexRoutesPostgresReadiness(app, dependencies);
  return app;
}

const freshSecret = "postgres://fresh-user:fresh-password@fresh.invalid/database";

test("readiness uses only the cache-disabled binding and server-owned request identity", async () => {
  const created = [];
  const healthContexts = [];
  const app = appWith({
    randomUUID: () => "server-generated-id",
    createDatabase(options) {
      created.push(options);
      return {
        cacheMode: "disabled",
        async health(context) {
          healthContexts.push(context);
          return { ok: true, latencyMs: 1, shardId: options.shardId };
        },
      };
    },
  });
  const response = await app.request(POSTGRES_READINESS_PATH, {
    headers: { "x-request-id": "caller-controlled-id" },
  }, {
    RELAY_POSTGRES: { connectionString: freshSecret },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ready",
    service: "xmatrix-postgres",
    cacheMode: "disabled",
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].connectionString, freshSecret);
  assert.equal(created[0].shardId, "shard-0");
  assert.deepEqual(healthContexts, [{
    requestId: "postgres-readiness:server-generated-id",
    operation: "postgres.readiness",
  }]);
});

test("readiness fails closed when the fresh binding or shard identity is absent", async () => {
  let creates = 0;
  const app = appWith({ createDatabase() { creates += 1; throw new Error("must not run"); } });
  for (const env of [
    { RELAY_POSTGRES_SHARD_ID: "shard-0" },
    { RELAY_POSTGRES: { connectionString: freshSecret } },
  ]) {
    const response = await app.request(POSTGRES_READINESS_PATH, {}, env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "unavailable",
      service: "xmatrix-postgres",
      code: "postgres_unavailable",
      retryable: true,
    });
  }
  assert.equal(creates, 0);
});

test("transient failures are retryable and never expose driver or credential details", async () => {
  const app = appWith({
    createDatabase() {
      return {
        cacheMode: "disabled",
        async health() {
          const error = new Error(`connection failed for ${freshSecret}`);
          error.code = "ECONNRESET";
          throw error;
        },
      };
    },
  });
  const response = await app.request(POSTGRES_READINESS_PATH, {}, {
    RELAY_POSTGRES: { connectionString: freshSecret },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
  });
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(text.includes("fresh-password"), false);
  assert.equal(text.includes("ECONNRESET"), false);
  assert.deepEqual(JSON.parse(text), {
    status: "unavailable",
    service: "xmatrix-postgres",
    code: "postgres_unavailable",
    retryable: true,
  });
});

/** Two configured correctness shards, shard-0 holding the fresh secret. */
const TWO_SHARD_ENV = {
  RELAY_POSTGRES: { connectionString: freshSecret },
  RELAY_POSTGRES_SHARD_ID: "shard-0",
  RELAY_POSTGRES_SHARD_1: { connectionString: "postgres://shard-1.invalid/database" },
  RELAY_POSTGRES_SHARD_1_ID: "shard-1",
};

test("readiness probes every configured correctness shard", async () => {
  const created = [];
  const checked = [];
  const app = appWith({
    createDatabase(options) {
      created.push(options);
      return { cacheMode: "disabled", async health() { checked.push(options.shardId); } };
    },
  });
  const response = await app.request(POSTGRES_READINESS_PATH, {}, TWO_SHARD_ENV);

  assert.equal(response.status, 200);
  assert.deepEqual(created.map(({ shardId }) => shardId), ["shard-0", "shard-1"]);
  assert.deepEqual(checked.sort(), ["shard-0", "shard-1"]);
});

test("readiness probes configured shards concurrently", async () => {
  const blockers = [];
  const app = appWith({
    createDatabase(options) {
      return {
        cacheMode: "disabled",
        async health() {
          await new Promise((resolve) => blockers.push({ shardId: options.shardId, resolve }));
        },
      };
    },
  });
  const pending = app.request(POSTGRES_READINESS_PATH, {}, TWO_SHARD_ENV);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(blockers.map(({ shardId }) => shardId).sort(), ["shard-0", "shard-1"]);
  for (const blocker of blockers) blocker.resolve();
  assert.equal((await pending).status, 200);
});

test("one failed shard returns 503 only after every parallel probe settles", async () => {
  const settled = [];
  const app = appWith({
    createDatabase(options) {
      return {
        cacheMode: "disabled",
        async health() {
          if (options.shardId === "shard-0") throw new Error("offline");
          await new Promise((resolve) => setTimeout(resolve, 5));
          settled.push(options.shardId);
        },
      };
    },
  });
  const response = await app.request(POSTGRES_READINESS_PATH, {}, TWO_SHARD_ENV);
  assert.equal(response.status, 503);
  assert.deepEqual(settled, ["shard-1"]);
});
