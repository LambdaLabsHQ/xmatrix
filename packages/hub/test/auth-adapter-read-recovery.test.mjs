import assert from "node:assert/strict";
import test from "node:test";

import { retryAuthAdapterReads } from "../src/auth-authority.ts";

// Better Auth's Kysely adapter owns this pool, so the authority client's
// single_read retry never saw these reads. Exercise the pool boundary the
// adapter uses: connect(), then client.query(sql, values).
function adapterPool(outcomes) {
  const connections = [];
  const pool = {
    connections,
    async connect() {
      const index = connections.length;
      const outcome = outcomes[index];
      const client = {
        index,
        queries: [],
        releases: [],
        async query(input, ...rest) {
          client.queries.push(typeof input === "string" ? input : input.text);
          const callback = rest.find((value) => typeof value === "function");
          if (callback) {
            callback(undefined, { rows: [], rowCount: 0 });
            return undefined;
          }
          if (outcome instanceof Error) {
            outcomes[index] = undefined;
            throw outcome;
          }
          if (typeof outcome === "function") return outcome(input, ...rest);
          return { rows: [], rowCount: 0 };
        },
        release(destroy) {
          client.releases.push(destroy);
        },
      };
      connections.push(client);
      return client;
    },
  };
  return retryAuthAdapterReads(pool);
}

test("an adapter SELECT recovers one lost response on a fresh connection (HUB-DD)", async () => {
  const pool = adapterPool([new Error("Query read timeout"),
    () => ({ rows: [{ id: "session-1" }], rowCount: 1 })]);
  const client = await pool.connect();
  const result = await client.query('select "id" from "session" where "token"=$1', ["token"]);
  assert.deepEqual(result.rows, [{ id: "session-1" }]);
  assert.equal(pool.connections.length, 2, "the stalled checkout is replaced");
  assert.deepEqual(pool.connections[1].queries, ['select "id" from "session" where "token"=$1']);
  assert.equal(pool.connections[1].releases.length, 1, "the recovery checkout is returned");
  assert.notEqual(pool.connections[1].releases[0], true, "the recovery checkout is not destroyed");
});

test("an object query recovers a pool-slot connect timeout", async () => {
  const pool = adapterPool([new Error("Timed out while waiting for an open slot in the pool."),
    () => ({ rows: [{ id: "user-1" }], rowCount: 1 })]);
  const client = await pool.connect();
  const result = await client.query({ text: 'select "id" from "user" where "id"=$1', values: ["user-1"] });
  assert.deepEqual(result.rows, [{ id: "user-1" }]);
  assert.equal(pool.connections.length, 2);
});

test("an adapter write is never replayed after an unknown response", async () => {
  const failure = new Error("Query read timeout");
  const pool = adapterPool([failure]);
  const client = await pool.connect();
  await assert.rejects(client.query('insert into "session" ("id") values ($1)', ["s"]),
    candidate => candidate === failure);
  assert.equal(pool.connections.length, 1, "a write's outcome is unknown, not retried");
});

test("an answered database error is not replayed", async () => {
  const answered = Object.assign(new Error("statement timeout"), { code: "57014" });
  const pool = adapterPool([answered]);
  const client = await pool.connect();
  await assert.rejects(client.query('select "id" from "session"'),
    candidate => candidate === answered);
  assert.equal(pool.connections.length, 1);
});

test("adapter reads recover at most one lost response", async () => {
  const pool = adapterPool([new Error("Query read timeout"), new Error("Query read timeout")]);
  const client = await pool.connect();
  await assert.rejects(client.query('select "id" from "session"'), /Query read timeout/u);
  assert.equal(pool.connections.length, 2, "no third attempt");
});

test("a callback-style adapter query keeps its original behaviour", async () => {
  const pool = adapterPool([]);
  const client = await pool.connect();
  const rows = await new Promise((resolve, reject) => {
    client.query('select "id" from "session"', [], (error) => {
      if (error) reject(error);
      else resolve("callback");
    });
  });
  assert.equal(rows, "callback");
  assert.deepEqual(client.releases, []);
});
