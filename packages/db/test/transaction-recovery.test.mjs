import assert from "node:assert/strict";
import test from "node:test";
import { lockTimeoutBeforeCommit } from "../dist/client.js";
import { retryBeforeCommit, retryTransactionBeforeCommit } from "../dist/transaction-recovery.js";

const lockTimeout = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

/** A database whose sessions fail or answer on demand, recording how many it opened and closed. */
function sessions(attempts) {
  const opened = [];
  return {
    opened,
    database: {
      openSession() {
        const index = opened.length;
        opened.push({ closed: false });
        return {
          transaction: async (_context, callback) => {
            const failure = attempts[index];
            if (failure) throw failure;
            return callback({ query: async () => [] });
          },
          close: async () => { opened[index].closed = true; },
        };
      },
    },
  };
}

test("a message append replays one lock-deadline abort on a fresh session (HUB-AZ)", async () => {
  const { database, opened } = sessions([lockTimeout(), undefined]);
  const value = await retryTransactionBeforeCommit(database, { requestId: "request", operation: "message.append" },
    async () => "appended");
  assert.equal(value, "appended");
  assert.equal(opened.length, 2, "one fresh session per attempt");
  assert.ok(opened.every(session => session.closed));
});

test("a command whose rejection is the evidence keeps its one attempt", async () => {
  const failure = lockTimeout();
  const { database, opened } = sessions([failure, undefined]);
  await assert.rejects(retryTransactionBeforeCommit(database,
    { requestId: "request", operation: "machine-control.report" }, async () => "reported"),
  error => error === failure);
  assert.equal(opened.length, 1, "the Machine scope lock's rejection is not replayed");
});

test("only a lock-deadline abort is replayed; other answered failures stay final", async () => {
  for (const error of [Object.assign(new Error("statement timeout"), { code: "57014" }),
    Object.assign(new Error("deadlock detected"), { code: "40P01" })]) {
    const { database, opened } = sessions([error]);
    await assert.rejects(retryTransactionBeforeCommit(database,
      { requestId: "request", operation: "message.append" }, async () => "appended"),
    failure => failure === error);
    assert.equal(opened.length, 1);
  }
});

test("a lost response still replays for every database-only caller, and exhausted evidence is linked", async () => {
  const lost = () => new Error("Query read timeout");
  const once = sessions([lost(), undefined]);
  assert.equal(await retryBeforeCommit(async () => {
    const session = once.database.openSession();
    return session.transaction({}, async () => "done");
  }), "done");
  assert.equal(JSON.stringify(once.opened.length), "2");

  const second = lockTimeout();
  const twice = sessions([lockTimeout(), second]);
  await assert.rejects(retryTransactionBeforeCommit(twice.database,
    { requestId: "request", operation: "message.append" }, async () => "appended"),
  error => error === second);
  assert.equal(twice.opened.length, 2, "never a third attempt");
});

test("the lock-deadline predicate matches only the aborted statement", () => {
  assert.equal(lockTimeoutBeforeCommit(lockTimeout()), true);
  assert.equal(lockTimeoutBeforeCommit(Object.assign(new Error("x"), { code: "55P03" })), true);
  assert.equal(lockTimeoutBeforeCommit(Object.assign(new Error("x"), { code: "55p03" })), true);
  for (const code of ["57014", "40P01", "28P01", "QUERY_READ_TIMEOUT", undefined]) {
    assert.equal(lockTimeoutBeforeCommit(code ? Object.assign(new Error("x"), { code }) : new Error("x")), false);
  }
});
