import assert from "node:assert/strict";
import { test } from "node:test";

import { cacheFamily, cachesToDelete } from "./prune-actions-caches.mjs";

const now = Date.parse("2026-10-06T21:00:00Z");
const sha = (digit) => digit.repeat(40);
const digest = (digit) => digit.repeat(64);
let nextId = 1;
const cache = (key, ref, created, accessed = created) => ({
  id: nextId++, key, ref, created_at: created, last_accessed_at: accessed, size_in_bytes: 1,
});
const deleted = (caches, openPullRequests = new Set()) =>
  cachesToDelete(caches, { openPullRequests, now }).map(({ cache: entry, reason }) => [entry.key, entry.ref, reason]);

test("a cache family strips commit SHA, lockfile digest on commit-keyed caches, and CodeQL CLI version", () => {
  assert.equal(cacheFamily(`kache-Linux-rust-cli-${digest("f")}-${sha("a")}`), "kache-Linux-rust-cli");
  assert.equal(cacheFamily(`kache-cli-release-v1-macos-x64-${digest("1")}-${sha("a")}`), "kache-cli-release-v1-macos-x64");
  assert.equal(cacheFamily(`kache-Windows-test-v2-${digest("2")}-${sha("b")}`), "kache-Windows-test-v2");
  assert.equal(cacheFamily(`next-cache-${digest("3")}-${sha("c")}`), "next-cache");
  assert.equal(cacheFamily(`turbo-Linux-hub-${sha("d")}`), "turbo-Linux-hub");
  assert.equal(cacheFamily(`codeql-trap-1-2.27.6-javascript-${sha("e")}`), "codeql-trap-1-javascript");
  assert.equal(cacheFamily(`codeql-trap-1-2.27.5-rust-${sha("e")}`), "codeql-trap-1-rust");
  // Exact-match caches without a commit SHA keep their digest so older open PRs
  // continue to hit until the 3-day staleness rule retires unused entries.
  assert.equal(cacheFamily(`playwright-Linux-${digest("4")}`), `playwright-Linux-${digest("4")}`);
  assert.equal(cacheFamily(`test-postgres-Linux-X64-${digest("5")}`), `test-postgres-Linux-X64-${digest("5")}`);
  assert.equal(cacheFamily("pnpm-store-Linux-abc"), "pnpm-store-Linux-abc");
});

test("only the newest entry of a family survives on each ref across lockfile and CodeQL version updates", () => {
  const caches = [
    cache(`turbo-Linux-hub-${sha("a")}`, "refs/heads/main", "2026-10-06T19:00:00Z"),
    cache(`turbo-Linux-hub-${sha("b")}`, "refs/heads/main", "2026-10-06T20:00:00Z"),
    cache(`turbo-Linux-hub-${sha("c")}`, "refs/heads/main", "2026-10-06T18:00:00Z"),
    // Lockfile digest changes on commit-keyed caches supersede earlier lockfiles on the same ref.
    cache(`kache-cli-release-v1-linux-x64-${digest("1")}-${sha("a")}`, "refs/heads/main", "2026-10-06T18:00:00Z"),
    cache(`kache-cli-release-v1-linux-x64-${digest("2")}-${sha("b")}`, "refs/heads/main", "2026-10-06T20:00:00Z"),
    cache(`kache-cli-release-v1-macos-x64-${digest("1")}-${sha("a")}`, "refs/heads/main", "2026-10-06T18:00:00Z"),
    cache(`kache-Windows-test-v2-${digest("1")}-${sha("a")}`, "refs/heads/main", "2026-10-06T17:00:00Z"),
    cache(`kache-Windows-test-v2-${digest("2")}-${sha("b")}`, "refs/heads/main", "2026-10-06T19:00:00Z"),
    // CodeQL CLI version bumps supersede prior TRAP caches for the same language, not other languages.
    cache(`codeql-trap-1-2.27.5-javascript-${sha("a")}`, "refs/heads/main", "2026-10-06T17:00:00Z"),
    cache(`codeql-trap-1-2.27.6-javascript-${sha("b")}`, "refs/heads/main", "2026-10-06T19:00:00Z"),
    cache(`codeql-trap-1-2.27.5-rust-${sha("a")}`, "refs/heads/main", "2026-10-06T17:00:00Z"),
    // Exact-match caches without a commit SHA stay distinct across lockfile hashes while recently accessed.
    cache(`playwright-Linux-${digest("1")}`, "refs/heads/main", "2026-10-06T17:00:00Z"),
    cache(`playwright-Linux-${digest("2")}`, "refs/heads/main", "2026-10-06T19:00:00Z"),
    // Other families and other refs are kept apart.
    cache(`turbo-Linux-web-${sha("a")}`, "refs/heads/main", "2026-10-06T19:00:00Z"),
    cache(`turbo-Linux-hub-${sha("d")}`, "refs/pull/7/merge", "2026-10-06T17:00:00Z"),
  ];
  assert.deepEqual(deleted(caches, new Set([7])).sort(), [
    [`codeql-trap-1-2.27.5-javascript-${sha("a")}`, "refs/heads/main", "superseded"],
    [`kache-Windows-test-v2-${digest("1")}-${sha("a")}`, "refs/heads/main", "superseded"],
    [`kache-cli-release-v1-linux-x64-${digest("1")}-${sha("a")}`, "refs/heads/main", "superseded"],
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
