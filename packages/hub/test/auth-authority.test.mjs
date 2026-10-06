import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_POSTGRES_TYPES,
  authDirectoryAdminUsers,
  authAuthority,
  createAuthPostgresPool,
  parseAuthPostgresInt8,
  requireAuthD1,
  withAuthPostgresPool,
} from "../src/auth-authority.ts";

test("Auth authority defaults to D1 for merge-safe Main rollout", () => {
  assert.equal(authAuthority({}), "d1");
  assert.equal(authAuthority({ AUTH_AUTHORITY: "d1" }), "d1");
  const database = {};
  assert.equal(requireAuthD1({ AUTH_DB: database }), database);
});

test("Auth authority rejects unknown and never falls back from PostgreSQL", () => {
  assert.throws(() => authAuthority({ AUTH_AUTHORITY: "dual" }), /must be d1 or postgres/);
  assert.throws(
    () => requireAuthD1({ AUTH_AUTHORITY: "postgres", AUTH_DB: {} }),
    /D1 Auth authority is unavailable/,
  );
});

test("Auth admin users report every registration with bounded session activity", async () => {
  const rows = [{
    id: "user-1",
    name: "One",
    handle: "one",
    email: "one@example.com",
    email_verified: 1,
    created_at: "2026-09-01T00:00:00.000Z",
    profile_completed_at: "2026-09-02T00:00:00.000Z",
    session_count: 3,
    active_sessions: 1,
    last_session_at: "2026-09-17T11:00:00.000Z",
    providers: "github,credential",
  }, {
    id: "user-2",
    name: "Two",
    handle: null,
    email: "two@example.com",
    email_verified: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    profile_completed_at: null,
    session_count: 0,
    active_sessions: 0,
    last_session_at: null,
    providers: null,
  }];
  const database = {
    prepare(sql) {
      if (sql.includes("COUNT(*) AS")) {
        return { async first() { return { count: rows.length }; } };
      }
      return {
        bind() {
          return { async all() { return { results: rows }; } };
        },
      };
    },
  };
  const result = await authDirectoryAdminUsers(
    { AUTH_DB: database },
    "2026-09-17T12:00:00.000Z",
    10,
  );
  assert.equal(result.users.length, 2);
  assert.deepEqual(result.users[0].providers, ["github", "credential"]);
  assert.equal(result.users[0].sessionCount, 3);
  assert.equal(result.users[0].activeSessions, 1);
  assert.deepEqual(result.access, {
    registeredUsers: 2,
    emailVerifiedUsers: 1,
    completedProfiles: 1,
    activeUsersLast24h: 1,
    activeUsersLast7d: 1,
    activeUsersLast30d: 1,
  });
});

test("Auth PostgreSQL parses int8 profile versions as safe numbers", () => {
  assert.equal(parseAuthPostgresInt8("7"), 7);
  assert.equal(AUTH_POSTGRES_TYPES.getTypeParser(20, "text")("7"), 7);
  assert.throws(
    () => parseAuthPostgresInt8("9007199254740992"),
    /safe range/,
  );
});

test("Auth PostgreSQL pool does not set a session search_path", async () => {
  const pool = createAuthPostgresPool({
    AUTH_AUTHORITY: "postgres",
    RELAY_POSTGRES: { connectionString: "postgres://auth@127.0.0.1:1/xmatrix" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
  });
  try {
    assert.equal(pool.options.options, undefined);
    assert.equal(JSON.stringify(pool.options).includes("search_path"), false);
  } finally {
    await pool.end();
  }
});

test("Auth PostgreSQL pools are request-scoped and close after success", async () => {
  const pools = [];
  const closed = [];
  const poolFactory = () => {
    const pool = {
      async end() {
        closed.push(pool);
      },
    };
    pools.push(pool);
    return pool;
  };

  const first = await withAuthPostgresPool({}, async (pool) => pool, poolFactory);
  const second = await withAuthPostgresPool({}, async (pool) => pool, poolFactory);

  assert.equal(pools.length, 2);
  assert.notEqual(first, second);
  assert.deepEqual(closed, pools);
});

test("Auth PostgreSQL pools close when the request fails", async () => {
  let closes = 0;
  await assert.rejects(
    withAuthPostgresPool(
      {},
      async () => {
        throw new Error("handler failed");
      },
      () => ({ async end() { closes += 1; } }),
    ),
    /handler failed/,
  );
  assert.equal(closes, 1);
});
