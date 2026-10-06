#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BUCKET = "xmatrix-release-assets";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const COMPONENTS = ["cli", "desktop", "android"];

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

export function validatePrunableRelease({ objects, manifest, release, currentPrefixes, now = Date.now() }) {
  const prefix = manifest?.prefix;
  if (!prefix || currentPrefixes.has(prefix)) return false;
  if (!/^releases\/(?:cli|desktop|android)-v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(prefix)) return false;
  const tag = prefix.slice("releases/".length);
  if (
    manifest.releaseTag !== tag ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  )
    return false;
  if (
    release?.tag_name !== tag ||
    release.draft ||
    release.prerelease ||
    !release.body?.includes("<!-- xmatrix-release-transaction:r2-archive-")
  )
    return false;
  const cutoff = now - RETENTION_MS;
  if (objects.some((object) => !object.last_modified || Date.parse(object.last_modified) > cutoff)) return false;

  const expectedKeys = new Set([`${prefix}/xmatrix-r2-manifest.json`, ...manifest.files.map((file) => file.key)]);
  // Build machines upload each run attempt as its own part; the attempts the
  // sealed manifest did not pick are unreferenced and go with the release.
  const isReleasePart = (key) => /^parts\/[a-z0-9][a-z0-9-]*\/\d+-\d+\/[^/]+$/u.test(key.slice(prefix.length + 1));
  if (objects.some((object) => !expectedKeys.has(object.key) && !isReleasePart(object.key))) return false;
  const archived = new Map((release.assets || []).map((asset) => [asset.name, asset]));
  if (archived.size !== manifest.files.length) return false;
  return manifest.files.every((file) => {
    const asset = archived.get(file.name);
    if (!asset || asset.size !== file.size) return false;
    return !asset.digest || asset.digest === `sha256:${file.sha256}`;
  });
}

export async function pruneR2ReleaseAssets({
  accountId,
  cloudflareToken,
  githubToken,
  repository,
  fetchImpl = fetch,
  now = Date.now(),
}) {
  accountId = required(accountId, "CLOUDFLARE_ACCOUNT_ID");
  cloudflareToken = required(cloudflareToken, "CLOUDFLARE_API_TOKEN");
  githubToken = required(githubToken, "GITHUB_TOKEN");
  repository = required(repository, "GITHUB_REPOSITORY");
  const cfBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${BUCKET}`;
  const cfHeaders = { Authorization: `Bearer ${cloudflareToken}` };
  const githubHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const getObjectJson = async (key, allowMissing = false) => {
    const response = await fetchImpl(`${cfBase}/objects/${objectPath(key)}`, { headers: cfHeaders });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 object read ${key} failed (${response.status})`);
    return response.json();
  };

  const currentPrefixes = new Set();
  const protectedComponents = new Set();
  for (const component of COMPONENTS) {
    const pointer = await getObjectJson(`channels/${component}/stable.json`, true);
    if (pointer?.component === component && pointer.channel === "stable" && pointer.prefix) {
      currentPrefixes.add(pointer.prefix);
      protectedComponents.add(component);
    }
    // A release waiting on dev for promotion is as current as stable's.
    const dev = await getObjectJson(`channels/${component}/dev.json`, true);
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

  const groups = new Map();
  for (const object of objects) {
    const match = object.key?.match(/^(releases\/(?:cli|desktop|android)-v[^/]+)\//u);
    if (!match) continue;
    const group = groups.get(match[1]) || [];
    group.push(object);
    groups.set(match[1], group);
  }

  const deleted = [];
  for (const [prefix, group] of groups) {
    const component = prefix.slice("releases/".length).split("-v", 1)[0];
    if (!protectedComponents.has(component) || currentPrefixes.has(prefix)) continue;
    const manifestObject = group.find((object) => object.key === `${prefix}/xmatrix-r2-manifest.json`);
    if (!manifestObject) continue;
    const manifest = await getObjectJson(manifestObject.key);
    const tag = prefix.slice("releases/".length);
    const releaseResponse = await fetchImpl(
      `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      { headers: githubHeaders }
    );
    if (releaseResponse.status === 404) continue;
    if (!releaseResponse.ok) throw new Error(`GitHub archive read ${tag} failed (${releaseResponse.status})`);
    const release = await releaseResponse.json();
    if (!validatePrunableRelease({ objects: group, manifest, release, currentPrefixes, now })) continue;

    const manifestKey = `${prefix}/xmatrix-r2-manifest.json`;
    const deletionOrder = [...group].sort(
      (left, right) => Number(left.key === manifestKey) - Number(right.key === manifestKey)
    );
    for (const object of deletionOrder) {
      const response = await fetchImpl(`${cfBase}/objects/${objectPath(object.key)}`, {
        method: "DELETE",
        headers: cfHeaders,
      });
      await jsonResponse(response, `R2 object delete ${object.key}`);
      deleted.push(object.key);
    }
    process.stdout.write(`Pruned verified historical R2 release ${tag}\n`);
  }
  return deleted;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  pruneR2ReleaseAssets({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
