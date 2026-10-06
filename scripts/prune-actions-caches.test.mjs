import assert from "node:assert/strict";
import { test } from "node:test";

import { cacheFamily, cachesToDelete } from "./prune-actions-caches.mjs";

const now = Date.parse("2026-10-06T21:00:00Z");
const sha = (digit) => digit.repeat(40);
let nextId = 1;
const cache = (key, ref, created, accessed = created) => ({
  id: nextId++, key, ref, created_at: created, last_accessed_at: accessed, size_in_bytes: 1,
});
const deleted = (caches, openPullRequests = new Set()) =>
  cachesToDelete(caches, { openPullRequests, now }).map(({ cache: entry, reason }) => [entry.key, entry.ref, reason]);

test("a cache family is its key without the commit", () => {
  assert.equal(cacheFamily(`kache-Linux-rust-cli-${"f".repeat(64)}-${sha("a")}`), `kache-Linux-rust-cli-${"f".repeat(64)}`);
  assert.equal(cacheFamily("pnpm-store-Linux-abc"), "pnpm-store-Linux-abc");
});

test("only the newest entry of a family survives on each ref", () => {
  const caches = [
    cache(`turbo-Linux-hub-${sha("a")}`, "refs/heads/main", "2026-10-06T19:00:00Z"),
    cache(`turbo-Linux-hub-${sha("b")}`, "refs/heads/main", "2026-10-06T20:00:00Z"),
    cache(`turbo-Linux-hub-${sha("c")}`, "refs/heads/main", "2026-10-06T18:00:00Z"),
    // Other families and other refs are kept apart.
    cache(`turbo-Linux-web-${sha("a")}`, "refs/heads/main", "2026-10-06T19:00:00Z"),
    cache(`turbo-Linux-hub-${sha("d")}`, "refs/pull/7/merge", "2026-10-06T17:00:00Z"),
  ];
  assert.deepEqual(deleted(caches, new Set([7])).sort(), [
    [`turbo-Linux-hub-${sha("a")}`, "refs/heads/main", "superseded"],
    [`turbo-Linux-hub-${sha("c")}`, "refs/heads/main", "superseded"],
  ]);
});

test("a closed pull request's caches and stale entries go", () => {
  const caches = [
    cache("pnpm-store-Linux-abc", "refs/pull/3/merge", "2026-10-06T20:00:00Z"),
    cache("pnpm-store-Linux-abc", "refs/pull/4/merge", "2026-10-06T20:00:00Z"),
    cache("playwright-Linux-x", "refs/heads/main", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
    cache("playwright-Linux-y", "refs/heads/main", "2026-10-01T00:00:00Z", "2026-10-06T00:00:00Z"),
  ];
  assert.deepEqual(deleted(caches, new Set([4])).sort(), [
    ["playwright-Linux-x", "refs/heads/main", "unused for three days"],
    ["pnpm-store-Linux-abc", "refs/pull/3/merge", "closed pull request"],
  ]);
});
