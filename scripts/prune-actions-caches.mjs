#!/usr/bin/env node
// Keeps the repository's Actions caches inside GitHub's 10 GB budget by
// deleting entries no run will restore again, so eviction never takes one a
// run still needs.
//
// CI saves compile caches under `<family>-<commit sha>` and restores the
// newest entry of a family by prefix, so on each ref only the newest entry of
// a family can ever be restored. A closed pull request's ref is never
// restored from again, and an entry nobody touched for days has been
// superseded.
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** Pure: the family a cache key belongs to: the key without its commit SHA. */
export function cacheFamily(key) {
  return key.replace(/-[0-9a-f]{40}$/u, "");
}

/**
 * Pure: the caches to delete, each with its reason. `caches` are GitHub
 * cache records ({ id, key, ref, created_at, last_accessed_at });
 * `openPullRequests` holds the numbers of open pull requests.
 */
export function cachesToDelete(caches, { openPullRequests, now = Date.now() }) {
  const deletions = new Map();
  const newest = new Map();
  for (const cache of caches) {
    const pull = /^refs\/pull\/(\d+)\/merge$/u.exec(cache.ref);
    if (pull && !openPullRequests.has(Number(pull[1]))) {
      deletions.set(cache.id, { cache, reason: "closed pull request" });
      continue;
    }
    if (now - Date.parse(cache.last_accessed_at) > STALE_AFTER_MS) {
      deletions.set(cache.id, { cache, reason: "unused for three days" });
      continue;
    }
    const slot = `${cache.ref}\0${cacheFamily(cache.key)}`;
    const current = newest.get(slot);
    if (!current) {
      newest.set(slot, cache);
    } else if (Date.parse(cache.created_at) > Date.parse(current.created_at)) {
      deletions.set(current.id, { cache: current, reason: "superseded" });
      newest.set(slot, cache);
    } else {
      deletions.set(cache.id, { cache, reason: "superseded" });
    }
  }
  return [...deletions.values()];
}

async function github(pathname, { token, method = "GET" } = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  // Another pruner may have deleted the entry first.
  if (method === "DELETE" && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub ${method} ${pathname}: ${response.status}`);
  return method === "DELETE" ? undefined : response.json();
}

async function listAll(pathname, field, token) {
  const items = [];
  // Bounded: 100 pages of 100 is far beyond what a 10 GB budget holds.
  for (let page = 1; page <= 100; page += 1) {
    const separator = pathname.includes("?") ? "&" : "?";
    const body = await github(`${pathname}${separator}per_page=100&page=${page}`, { token });
    const batch = field ? body[field] : body;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const dryRun = process.argv.includes("--dry-run");
  const caches = await listAll(`/repos/${repo}/actions/caches`, "actions_caches", token);
  const pulls = await listAll(`/repos/${repo}/pulls?state=open`, undefined, token);
  const deletions = cachesToDelete(caches, { openPullRequests: new Set(pulls.map((pull) => pull.number)) });
  let freed = 0;
  for (const { cache, reason } of deletions) {
    console.log(`${dryRun ? "would delete" : "delete"} ${cache.key} on ${cache.ref} (${reason})`);
    if (!dryRun) await github(`/repos/${repo}/actions/caches/${cache.id}`, { token, method: "DELETE" });
    freed += cache.size_in_bytes ?? 0;
  }
  const total = caches.reduce((sum, cache) => sum + (cache.size_in_bytes ?? 0), 0);
  console.log(`${deletions.length} of ${caches.length} caches, ${(freed / 2 ** 20).toFixed(0)} of ${(total / 2 ** 20).toFixed(0)} MiB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
