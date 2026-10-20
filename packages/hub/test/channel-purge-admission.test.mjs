import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase } from "@xmatrix/db";

import { maintainChannelDeletions } from "../src/channel-deletion-maintenance.ts";

/** A max-one pool. `failures[n]` is what checkout n throws on the admission read. */
function stallingPool(failures) {
  const clients = [];
  let current = null;
  return {
    clients,
    factory() {
      return {
        async connect() {
          if (current) return current;
          const index = clients.length;
          const client = {
            queries: [],
            releases: [],
            async query(input) {
              const text = typeof input === "string" ? input : input.text;
              client.queries.push(text);
              if (failures[index] && text.includes("channel_deletions")) throw failures[index];
              return { rows: [], rowCount: 0 };
            },
            release(destroy) {
              client.releases.push(Boolean(destroy));
              if (destroy) current = null;
            },
          };
          clients.push(client);
          current = client;
          return client;
        },
        async end() {},
      };
    },
  };
}

function envFor(pool) {
  return [{
    RELAY_PAYLOAD_BUCKET: {},
    RELAY_POSTGRES: { connectionString: "postgres://example.invalid/xmatrix" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
  }, {
    createDatabase: (options) => createAuthorityDatabase({ ...options, poolFactory: pool.factory }),
  }];
}

test("a lost channel-purge admission read is retried once and still recorded", async () => {
  const timeout = new Error("Query read timeout");
  const pool = stallingPool([timeout]);
  const [env, dependencies] = envFor(pool);
  await maintainChannelDeletions(env, dependencies);
  assert.equal(pool.clients.length, 2, "the lost round trip takes one fresh checkout");
  assert.deepEqual(pool.clients[0].releases, [true], "the stalled checkout is destroyed");
  assert.ok(pool.clients[0].queries.some((text) => text.includes("channel_purge") || text.includes("channel_deletions")));
  assert.equal(pool.clients[1].queries.length, 1);
});

test("a second channel-purge admission timeout still fails the pass", async () => {
  const second = new Error("Query read timeout");
  const pool = stallingPool([new Error("Query read timeout"), second, new Error("third")]);
  const [env, dependencies] = envFor(pool);
  await assert.rejects(maintainChannelDeletions(env, dependencies), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /Channel deletion maintenance requires retry/u);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0], second);
    return true;
  });
  assert.equal(pool.clients.length, 2, "the retry is not repeated");
});
