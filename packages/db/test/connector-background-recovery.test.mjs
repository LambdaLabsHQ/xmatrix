import assert from "node:assert/strict";
import test from "node:test";
import { ConnectivityBreaker, createAuthorityDatabase, DatabaseCircuitOpenError,
  DatabaseCommitUnknownError, PostgresGmailRoutingRepository, PostgresSentryEventRepository,
  PostgresGoogleChatRoomRepository, PostgresFeishuRoomRepository, PostgresTelegramRoomRepository,
  PostgresTeamsRoomRepository } from "../dist/index.js";

const operations = {
  "Gmail cleanup": database => new PostgresGmailRoutingRepository(database, "fixture-key").cleanup(),
  "Gmail claim": database => new PostgresGmailRoutingRepository(database, "fixture-key").claim(),
  "Sentry claim": database => new PostgresSentryEventRepository(database).claim({ requestId: "claim",
    appClientId: "client", appUuid: "00000000-0000-4000-8000-000000000001" }),
};
for (const Repository of [PostgresGoogleChatRoomRepository, PostgresFeishuRoomRepository,
  PostgresTelegramRoomRepository, PostgresTeamsRoomRepository]) {
  operations[`${Repository.name} room cleanup`] = database => new Repository(database).cleanup({ requestId: "cleanup", limit: 1 });
}

/** Wire failures exercise the real transaction owner, including its commit-unknown boundary. */
function fixture(stage, failures, breaker = new ConnectivityBreaker("fixture")) {
  const pools = [];
  const database = createAuthorityDatabase({ connectionString: "postgres://fixture", shardId: "fixture",
    connectivityBreaker: breaker, poolFactory: () => {
      const index = pools.length;
      const pool = { ended: false, queries: [], releases: [],
        async connect() {
          if (index > 0) assert.equal(pools[index - 1].ended, true, "close before taking a fresh checkout");
          if (stage === "checkout" && failures[index]) throw failures[index];
          return { async query(input) {
            const text = typeof input === "string" ? input : input.text;
            pool.queries.push(text);
            const phase = text.startsWith("BEGIN;") ? "begin" : text === "COMMIT" ? "commit" :
              /DELETE FROM data\.app_\w+_room_lifecycle/u.test(text) ? "second-delete" : "sql";
            if (phase === stage && failures[index]) throw failures[index];
            return { rows: /SELECT count\(\*\)/u.test(text) ? [{ count: "0" }] : [], rowCount: 0 };
          }, release(destroy) { pool.releases.push(destroy); } };
        },
        async end() { pool.ended = true; },
      };
      pools.push(pool);
      return pool;
    } });
  return { database, pools };
}

for (const [name, run] of Object.entries(operations)) {
  const stages = [["checkout", "Connection terminated due to connection timeout"],
    ["begin", "Query read timeout"], ["sql", "Connection terminated unexpectedly"],
    ...(name.endsWith("room cleanup") ? [["second-delete", "Query read timeout"]] : [])];
  test(`${name} recovers one lost checkout, BEGIN or SQL response on a fresh session (HUB-97/98/9B)`, async () => {
    for (const [stage, message] of stages) {
      const { database, pools } = fixture(stage, [new Error(message)]);
      assert.deepEqual(await run(database), name.endsWith("room cleanup") ? undefined : []);
      assert.equal(pools.length, 2, stage);
      assert.equal(pools.every(pool => pool.ended), true);
      assert.equal(pools[0].queries.includes("COMMIT"), false);
      assert.equal(pools[0].queries.includes("ROLLBACK"), false);
      assert.deepEqual(pools[0].releases, stage === "checkout" ? [] : [true]);
      assert.equal(pools[1].queries.at(-1), "COMMIT");
    }
  });

  test(`${name} surfaces a second connection loss without a third attempt`, async () => {
    for (const [stage] of stages) {
      const failure = () => new Error(stage === "checkout" ? "timeout exceeded when trying to connect" : "Query read timeout");
      const second = failure();
      const { database, pools } = fixture(stage, [failure(), second]);
      await assert.rejects(run(database), error => error === second);
      assert.equal(pools.length, 2, stage);
      assert.equal(pools.every(pool => pool.ended), true);
    }
  });

  test(`${name} never replays an unknown COMMIT, answered SQL rejection or open breaker`, async () => {
    for (const message of ["Query read timeout", "Connection terminated due to connection timeout"]) {
      const { database, pools } = fixture("commit", [new Error(message)]);
      await assert.rejects(run(database), DatabaseCommitUnknownError);
      assert.equal(pools.length, 1);
      assert.deepEqual(pools[0].releases, [true]);
    }
    const answered = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const rejected = fixture("sql", [answered]);
    await assert.rejects(run(rejected.database), error => error === answered);
    assert.equal(rejected.pools.length, 1);
    assert.equal(rejected.pools[0].queries.at(-1), "ROLLBACK");
    const breaker = new ConnectivityBreaker("fixture");
    for (let index = 0; index < 5; index++) breaker.failure();
    const blocked = fixture("checkout", [], breaker);
    await assert.rejects(run(blocked.database), DatabaseCircuitOpenError);
    assert.equal(blocked.pools.length, 1);
    assert.deepEqual(blocked.pools[0].queries, []);
  });
}
