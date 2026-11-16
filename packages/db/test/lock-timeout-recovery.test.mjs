import assert from "node:assert/strict";
import test from "node:test";
import { retryBeforeCommit } from "../dist/index.js";

const lockTimeout = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

test("a database-only command replays once after an answered lock timeout", async () => {
  let attempts = 0;
  const value = await retryBeforeCommit(async () => {
    attempts += 1;
    if (attempts === 1) throw lockTimeout();
    return "committed";
  });
  assert.equal(value, "committed");
  assert.equal(attempts, 2);
});

test("a second lock timeout escapes and never takes a third attempt", async () => {
  const first = lockTimeout(), second = lockTimeout();
  let attempts = 0;
  await assert.rejects(retryBeforeCommit(async () => {
    attempts += 1;
    throw attempts === 1 ? first : second;
  }), error => error === second);
  assert.equal(attempts, 2);
});

test("another answered rejection stays final", async () => {
  let attempts = 0;
  const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  await assert.rejects(retryBeforeCommit(async () => {
    attempts += 1;
    throw deadlock;
  }), error => error === deadlock);
  assert.equal(attempts, 1);
});
