import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseCommitUnknownError, PostgresGmailRoutingRepository } from "../dist/index.js";

/** An authority whose transactions fail with the given errors in turn, then claim nothing. */
function failing(...failures) {
  const database = {
    cacheMode: "disabled", calls: 0,
    async transaction(_context, run) {
      const failure = failures[database.calls++];
      if (failure) throw failure;
      return run({ query: async () => [] });
    },
  };
  return database;
}
const claim = database => new PostgresGmailRoutingRepository(database, "fixture-encryption-key").claim();

test("a claim whose response is lost before COMMIT claims again on a fresh checkout (XMATRIX-HUB-90)", async () => {
  for (const message of ["Query read timeout", "Connection terminated unexpectedly"]) {
    const database = failing(new Error(message));
    assert.deepEqual(await claim(database), []);
    assert.equal(database.calls, 2, message);
  }
});

test("a claim whose COMMIT outcome is unknown, or that is lost twice, is not replayed", async () => {
  const unknown = failing(new DatabaseCommitUnknownError("QUERY_READ_TIMEOUT"));
  await assert.rejects(claim(unknown), DatabaseCommitUnknownError);
  assert.equal(unknown.calls, 1);
  const twice = failing(new Error("Query read timeout"), new Error("Query read timeout"));
  await assert.rejects(claim(twice), /Query read timeout/u);
  assert.equal(twice.calls, 2);
});

test("a claim failure that is not a lost connection is not replayed", async () => {
  const database = failing(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
  await assert.rejects(claim(database), /deadlock/u);
  assert.equal(database.calls, 1);
});
