#!/usr/bin/env node

import fs from "node:fs";

import { runCliMain } from "./cli-entrypoint.mjs";
import { parseWranglerJsonValue } from "./wrangler-d1-readback.mjs";

export const NEXT_HYPERDRIVE_ORIGIN_CONNECTION_LIMITS = Object.freeze({
  fresh: 20,
  cached: 5,
  shard1Fresh: 20,
});

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactString(value, expected, label) {
  if (value !== expected) throw new Error(`${label} does not match the reviewed identity`);
}

function originIdentity(value, label) {
  const origin = record(value.origin, `${label}.origin`);
  for (const key of ["host", "database", "scheme", "user"]) {
    if (typeof origin[key] !== "string" || !origin[key]) {
      throw new Error(`${label}.origin.${key} is missing`);
    }
  }
  if (!Number.isSafeInteger(origin.port) || origin.port < 1 || origin.port > 65_535) {
    throw new Error(`${label}.origin.port is invalid`);
  }
  return [origin.scheme, origin.host, origin.port, origin.database, origin.user].join("\n");
}

export function verifyHyperdriveCachePolicy(input) {
  const fresh = record(input.fresh, "fresh");
  const cached = record(input.cached, "cached");
  exactString(fresh.id, input.freshId, "fresh.id");
  exactString(cached.id, input.cachedId, "cached.id");
  exactString(fresh.name, "xmatrix-next-fresh", "fresh.name");
  exactString(cached.name, "xmatrix-next-cached", "cached.name");
  if (fresh.origin_connection_limit !== NEXT_HYPERDRIVE_ORIGIN_CONNECTION_LIMITS.fresh) {
    throw new Error("fresh Hyperdrive origin connection limit must be 20");
  }
  if (cached.origin_connection_limit !== NEXT_HYPERDRIVE_ORIGIN_CONNECTION_LIMITS.cached) {
    throw new Error("cached Hyperdrive origin connection limit must be 5");
  }

  const freshCaching = record(fresh.caching, "fresh.caching");
  const cachedCaching = record(cached.caching, "cached.caching");
  if (freshCaching.disabled !== true) {
    throw new Error("fresh Hyperdrive query caching must be disabled");
  }
  if (cachedCaching.disabled !== false || cachedCaching.max_age !== 5) {
    throw new Error("cached Hyperdrive must use the reviewed five-second policy");
  }
  if (originIdentity(fresh, "fresh") !== originIdentity(cached, "cached")) {
    throw new Error("fresh and cached Hyperdrive must address the same reviewed origin");
  }
  if (fresh.mtls?.sslmode !== "require" || cached.mtls?.sslmode !== "require") {
    throw new Error("both Hyperdrive bindings must require origin TLS");
  }
}

export function parseHyperdriveReadback(raw) {
  return parseWranglerJsonValue(raw, (value) => (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    value.caching &&
    typeof value.caching === "object"
  ));
}

async function main(argv = process.argv.slice(2)) {
  const [freshPath, cachedPath, freshId, cachedId] = argv;
  if (!freshPath || !cachedPath || !freshId || !cachedId) {
    throw new Error("usage: hyperdrive-cache-policy.mjs <fresh-json> <cached-json> <fresh-id> <cached-id>");
  }
  verifyHyperdriveCachePolicy({
    fresh: parseHyperdriveReadback(fs.readFileSync(freshPath, "utf8")),
    cached: parseHyperdriveReadback(fs.readFileSync(cachedPath, "utf8")),
    freshId,
    cachedId,
  });
  console.log("Verified reviewed fresh and cached Hyperdrive policies");
}

runCliMain(import.meta.url, main);
