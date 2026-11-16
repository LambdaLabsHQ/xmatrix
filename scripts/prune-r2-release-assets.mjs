#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareSemver, releaseChannel } from "./release-version-order.mjs";

const BUCKET = "xmatrix-release-assets";
const COMPONENTS = ["cli", "desktop", "android"];
// What R2 keeps of each component (Daniel 2026-11-13): the releases its
// channels name, its newest stable releases, and the betas of the last week.
// Downloads and updates only ever resolve through a channel pointer, so an
// older release is read by no client. The bucket lock on `releases/` holds
// for the same week (scripts/configure-release-storage.mjs).
export const STABLE_RELEASES_KEPT = 10;
export const RECENT_RELEASE_MS = 7 * 24 * 60 * 60 * 1000;
const DELETE_CONCURRENCY = 8;
const DELETE_ATTEMPTS = 4;
const RELEASE_PREFIX = /^(releases\/(cli|desktop|android)-v([^/]+))\//u;

function required(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function objectPath(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function jsonResponse(response, label) {
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    throw new Error(`${label} failed (${response.status}): ${JSON.stringify(body.errors || body)}`);
  }
  return body;
}

function channelOf(version) {
  try {
    return releaseChannel(version);
  } catch {
    return null;
  }
}

/**
 * The release prefixes R2 no longer keeps. A component is pruned only when its
 * stable channel names a release, so a missing or unreadable pointer prunes
 * nothing of it. A release with any object written in the last week stays,
 * whatever its version: it may be a train still uploading. So does a prefix
 * whose version is not a release version: nothing here knows what it is.
 */
export function selectPrunableReleases({ objects, currentPrefixes, prunableComponents, now = Date.now() }) {
  const releases = new Map();
  for (const object of objects) {
    const match = RELEASE_PREFIX.exec(object.key || "");
    if (!match) continue;
    const [, prefix, component, version] = match;
    const release = releases.get(prefix) || { prefix, component, version, objects: [] };
    release.objects.push(object);
    releases.set(prefix, release);
  }

  const cutoff = now - RECENT_RELEASE_MS;
  const prunable = [];
  for (const component of COMPONENTS) {
    if (!prunableComponents.has(component)) continue;
    const own = [...releases.values()].filter((release) => release.component === component);
    const newestStable = new Set(
      own
        .filter((release) => channelOf(release.version) === "stable")
        .sort((left, right) => compareSemver(right.version, left.version))
        .slice(0, STABLE_RELEASES_KEPT)
        .map((release) => release.prefix)
    );
    for (const release of own) {
      if (!channelOf(release.version)) continue;
      if (currentPrefixes.has(release.prefix) || newestStable.has(release.prefix)) continue;
      const recent = release.objects.some((object) => {
        const modified = Date.parse(object.last_modified ?? "");
        return !Number.isFinite(modified) || modified > cutoff;
      });
      if (recent) continue;
      prunable.push(release);
    }
  }
  return prunable.sort((left, right) => left.prefix.localeCompare(right.prefix));
}

async function forEachLimited(items, limit, operation) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await operation(items[next++]);
  });
  await Promise.all(workers);
}

export async function pruneR2ReleaseAssets({
  accountId,
  cloudflareToken,
  fetchImpl = fetch,
  now = Date.now(),
  retryDelayMs = 1000,
}) {
  accountId = required(accountId, "CLOUDFLARE_ACCOUNT_ID");
  cloudflareToken = required(cloudflareToken, "CLOUDFLARE_API_TOKEN");
  const cfBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${BUCKET}`;
  const cfHeaders = { Authorization: `Bearer ${cloudflareToken}` };

  const getObjectJson = async (key) => {
    const response = await fetchImpl(`${cfBase}/objects/${objectPath(key)}`, { headers: cfHeaders });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 object read ${key} failed (${response.status})`);
    return response.json();
  };

  const currentPrefixes = new Set();
  const prunableComponents = new Set();
  for (const component of COMPONENTS) {
    const stable = await getObjectJson(`channels/${component}/stable.json`);
    if (stable?.component === component && stable.channel === "stable" && stable.prefix) {
      currentPrefixes.add(stable.prefix);
      prunableComponents.add(component);
    }
    const dev = await getObjectJson(`channels/${component}/dev.json`);
    if (dev?.component === component && dev.channel === "dev" && dev.prefix) currentPrefixes.add(dev.prefix);
  }

  const objects = [];
  let cursor;
  do {
    const query = new URLSearchParams({ prefix: "releases/", per_page: "1000" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetchImpl(`${cfBase}/objects?${query}`, { headers: cfHeaders });
    const body = await jsonResponse(response, "R2 object list");
    if (!Array.isArray(body.result)) throw new Error("R2 object list returned an invalid result");
    objects.push(...body.result);
    cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
  } while (cursor);

  // The API now and then answers a delete with an empty body; a delete is
  // idempotent, so it is asked again before the run gives up.
  const deleteObject = async (key) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetchImpl(`${cfBase}/objects/${objectPath(key)}`, { method: "DELETE", headers: cfHeaders });
        return await jsonResponse(response, `R2 object delete ${key}`);
      } catch (error) {
        if (attempt >= DELETE_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  };

  const releases = selectPrunableReleases({ objects, currentPrefixes, prunableComponents, now });
  const deleted = [];
  let bytes = 0;
  for (const release of releases) {
    // The manifest goes last: a run cut short leaves a release that still
    // names itself, and the next run deletes the rest.
    const manifestKey = `${release.prefix}/xmatrix-r2-manifest.json`;
    const files = release.objects.filter((object) => object.key !== manifestKey);
    const manifests = release.objects.filter((object) => object.key === manifestKey);
    for (const batch of [files, manifests]) {
      await forEachLimited(batch, DELETE_CONCURRENCY, async (object) => {
        await deleteObject(object.key);
        deleted.push(object.key);
        bytes += Number(object.size) || 0;
      });
    }
    process.stdout.write(`Pruned R2 release ${release.prefix.slice("releases/".length)}\n`);
  }
  process.stdout.write(
    `Pruned ${releases.length} releases, ${deleted.length} objects, ${(bytes / 1e9).toFixed(1)} GB; kept the channels' releases, ` +
      `the newest ${STABLE_RELEASES_KEPT} stable of each component and the last week's releases\n`
  );
  return deleted;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await pruneR2ReleaseAssets({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
