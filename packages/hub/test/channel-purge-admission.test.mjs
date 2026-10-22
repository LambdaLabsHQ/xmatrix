import assert from "node:assert/strict";
import test from "node:test";
import { createAuthorityDatabase, DatabaseCommitUnknownError } from "@xmatrix/db";

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

/** A database whose every transaction is a fresh session. `advanceFailures` are thrown, in order, by purge steps. */
function purgeDatabase(advanceFailures) {
  const operations = [];
  const tx = { async query(input) {
    if (input.name === "channel_purge_object_job_v1") return [{ state: "purging", objects_done: true }];
    if (input.name === "channel_purge_lock_v1") return [{ state: "completed", objects_done: true }];
    return [];
  } };
  const database = {
    cacheMode: "disabled",
    openSession() {
      const session = {
        cacheMode: "disabled",
        openSession() { return database.openSession(); },
        async close() {},
        async health() { return { ok: true, latencyMs: 0, shardId: "shard-0" }; },
        async transaction(context, run) {
          operations.push(context.operation);
          if (context.operation === "channel-purge.pending") {
            return [{ space_id: "space", channel_id: "chan", placement_epoch: 1 }];
          }
          if (context.operation === "channel-purge.advance") {
            const failure = advanceFailures.shift();
            if (failure) throw failure;
          }
          return run(tx);
        },
      };
      return session;
    },
    async transaction(context, run) {
      const session = database.openSession();
      try { return await session.transaction(context, run); }
      finally { await session.close(); }
    },
    async health() { return { ok: true, latencyMs: 0, shardId: "shard-0" }; },
  };
  return { database, operations };
}

function purgeEnv(database) {
  return [{
    RELAY_PAYLOAD_BUCKET: { async delete() { throw new Error("storage must not run"); } },
    RELAY_POSTGRES: { connectionString: "postgres://example.invalid/xmatrix" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
  }, { createDatabase: () => database }];
}

test("a lost channel-purge step is replayed once on a new session and the pass succeeds", async () => {
  const timeout = new Error("Query read timeout");
  const { database, operations } = purgeDatabase([timeout]);
  const [env, dependencies] = purgeEnv(database);
  await maintainChannelDeletions(env, dependencies);
  assert.deepEqual(operations.filter((operation) => operation === "channel-purge.advance"),
    ["channel-purge.advance", "channel-purge.advance", "channel-purge.advance"]);
  assert.equal(operations.includes("channel-purge.retry"), false);
});

test("a second lost channel-purge step fails the pass without reusing the dead session", async () => {
  const second = new Error("Query read timeout");
  const { database, operations } = purgeDatabase([new Error("Query read timeout"), second]);
  const [env, dependencies] = purgeEnv(database);
  await assert.rejects(maintainChannelDeletions(env, dependencies), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [second]);
    return true;
  });
  assert.equal(operations.filter((operation) => operation === "channel-purge.advance").length, 2);
  assert.equal(operations.filter((operation) => operation === "channel-purge.retry").length, 1);
  assert.equal(operations.some((operation) => String(operation).includes("unusable")), false);
});

test("an answered channel-purge failure is not replayed and still yields its slot", async () => {
  const answered = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  const { database, operations } = purgeDatabase([answered]);
  const [env, dependencies] = purgeEnv(database);
  await assert.rejects(maintainChannelDeletions(env, dependencies), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [answered]);
    return true;
  });
  assert.equal(operations.filter((operation) => operation === "channel-purge.advance").length, 1);
  assert.equal(operations.filter((operation) => operation === "channel-purge.retry").length, 1);
});

test("an unknown channel-purge commit is reconciled later instead of replayed", async () => {
  const unknown = new DatabaseCommitUnknownError("QUERY_READ_TIMEOUT");
  const { database, operations } = purgeDatabase([unknown]);
  const [env, dependencies] = purgeEnv(database);
  await assert.rejects(maintainChannelDeletions(env, dependencies), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [unknown]);
    return true;
  });
  assert.equal(operations.filter((operation) => operation === "channel-purge.advance").length, 1);
  assert.equal(operations.filter((operation) => operation === "channel-purge.retry").length, 1);
});
