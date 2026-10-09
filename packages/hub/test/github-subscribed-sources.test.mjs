import assert from "node:assert/strict";
import test from "node:test";

import { SubscribedSourcesIndex } from "../src/github-subscribed-sources.ts";

/** A Durable Object's storage, which outlives the object's eviction. */
function objectStorage() {
  const values = new Map();
  return {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    delete: async (key) => values.delete(key),
  };
}

const sources = [
  { sourceKind: "repository", sourceRef: "acme/app", feature: "commits" },
  { sourceKind: "issue", sourceRef: "github:issue:acme/app#7", feature: "checks" },
];

function index({ storage = objectStorage(), rows = sources, clock = { now: 0 } } = {}) {
  const reads = [];
  const read = async (installationId, limit) => { reads.push([installationId, limit]); return rows; };
  return { reads, storage, clock, index: new SubscribedSourcesIndex(storage, read, () => clock.now) };
}

test("a delivery none of whose sources is subscribed for its feature has no route", async () => {
  const { index: subscriptions } = index();
  assert.equal(await subscriptions.mayRoute("42", ["acme/other"], "checks"), false);
  assert.equal(await subscriptions.mayRoute("42", ["acme/app"], "checks"), false, "the repository subscribes to commits only");
  assert.equal(await subscriptions.mayRoute("42", ["ACME/App"], "commits"), true);
  assert.equal(await subscriptions.mayRoute("42", ["acme/app", "github:issue:acme/app#7"], "checks"), true);
});

test("the index is read once, kept across eviction, and read again after a forget or ten minutes", async () => {
  const storage = objectStorage(), clock = { now: 0 };
  const first = index({ storage, clock });
  await first.index.mayRoute("42", ["acme/app"], "commits");
  await first.index.mayRoute("42", ["acme/app"], "checks");
  assert.equal(first.reads.length, 1);

  const woken = index({ storage, clock });
  await woken.index.mayRoute("42", ["acme/app"], "commits");
  assert.equal(woken.reads.length, 0, "an evicted object answers from its storage");

  await woken.index.forget();
  await woken.index.mayRoute("42", ["acme/app"], "commits");
  assert.equal(woken.reads.length, 1);

  clock.now += 10 * 60_000;
  await woken.index.mayRoute("42", ["acme/app"], "commits");
  assert.equal(woken.reads.length, 2);
});

test("a read a forget overtook is not kept", async () => {
  const storage = objectStorage();
  let release;
  const reads = [];
  const subscriptions = new SubscribedSourcesIndex(storage, async () => {
    reads.push("read");
    if (reads.length === 1) await new Promise((resolve) => { release = resolve; });
    return reads.length === 1 ? [] : sources;
  }, () => 0);
  const stale = subscriptions.mayRoute("42", ["acme/app"], "commits");
  await new Promise((resolve) => setImmediate(resolve));
  await subscriptions.forget();
  release();
  assert.equal(await stale, false, "the delivery that raced the write is answered by what it read");
  assert.equal(await subscriptions.mayRoute("42", ["acme/app"], "commits"), true, "the next delivery reads again");
  assert.equal(reads.length, 2);
});

test("an installation with too many subscribed sources is not indexed", async () => {
  const many = Array.from({ length: 2_001 }, (_, number) => ({ sourceKind: "issue",
    sourceRef: `github:issue:acme/app#${number}`, feature: "checks" }));
  const { index: subscriptions, reads } = index({ rows: many });
  assert.equal(await subscriptions.mayRoute("42", ["acme/unrelated"], "pulls"), true);
  assert.deepEqual(reads, [["42", 2_001]]);
});
