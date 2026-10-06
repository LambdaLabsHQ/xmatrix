#!/usr/bin/env node

import fs from "node:fs";

import { parse as parseToml } from "smol-toml";

import { runCliMain } from "./cli-entrypoint.mjs";
import { parseHyperdriveReadback } from "./hyperdrive-cache-policy.mjs";
import {
  PRODUCTION_HYPERDRIVE_BINDINGS, productionHyperdrivePolicy, productionPostgresOrigin, verifyProductionHyperdrive,
} from "./production-hyperdrive-prepare.mjs";

export const PRODUCTION_POSTGRES_AUTHORITY_SELECTORS = Object.freeze([
  "AUTH_AUTHORITY",
]);

const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4";

const RETIRED_FACT_BINDINGS = Object.freeze([
  "RELAY_SPACE_ROOT_AUTHORITY", "RELAY_SPACE_MEMBERSHIP_AUTHORITY",
  "RELAY_CHANNEL_CATALOG_AUTHORITY", "RELAY_USER_PREFERENCE_AUTHORITY",
  "RELAY_AGENT_APP_POLICY_AUTHORITY", "RELAY_SCHEDULER_AUTHORITY",
  "RELAY_PROJECTION_AUTHORIZATION_AUTHORITY", "RELAY_TRACE_ACCESS_AUTHORITY",
  "RELAY_TRACE_ACCESS_LOCATOR", "RELAY_TRACE_ACCESS_USER_INDEX", "RELAY_SECRET_AUTHORITY",
]);

const RETAINED_DO_BINDINGS = Object.freeze([
  "RELAY_SUMMON_DECISION_CLOCK",
  "RELAY_SPACE_DELETION_CLOCK",
  "RELAY_PAGE_SESSION",
  "RELAY_SCOPED_CONTROL_AUTHORITY", "RELAY_CHANNEL_FAMILY_DATA",
  "RELAY_CHANNEL_FAMILY_DIRECTORY",
  "RELAY_POSTGRES_CHANNEL_COORDINATOR",
  "RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL",
  "RELAY_POSTGRES_BACKGROUND_ADMISSION",
  "RELAY_CONTROL_PLANE_DIRECTORY", "RELAY_RANK_AUTHORITY_DIRECTORY",
  "RELAY_GLOBAL_DIRECTORY_AUTHORITY", "RELAY_AGENT_APP_POLICY_LOCATOR",
  "RELAY_SPACE_PROJECTION", "RELAY_SPACE_CAPACITY_AUTHORITY", "RELAY_RUNTIME",
  "RELAY_RUNTIME_ROUTE_DIRECTORY", "RELAY_RUNTIME_CHANNEL_FANOUT", "DEVICE_AUTH",
]);

function parseConfig(source) {
  try {
    return parseToml(source);
  } catch (error) {
    throw new Error(`production config is not valid TOML: ${error.message}`);
  }
}

function requireVar(vars, name, expected) {
  if (vars[name] !== expected) throw new Error(`${name} must be ${JSON.stringify(expected)} in [vars]`);
}

export function verifyProductionPostgresConfig(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("production config is empty");
  const config = parseConfig(source);
  const vars = config.vars ?? {};
  for (const name of PRODUCTION_POSTGRES_AUTHORITY_SELECTORS) requireVar(vars, name, "postgres");
  for (const [name, value] of [
    ["RELAY_POSTGRES_SHARD_ID", "shard-0"],
    ["RELAY_POSTGRES_SHARD_1_ID", "shard-1"],
  ]) requireVar(vars, name, value);

  if ((config.d1_databases ?? []).length > 0) {
    throw new Error("production PostgreSQL cutover must not retain AUTH_DB/D1 bindings");
  }
  const durableObjects = (config.durable_objects?.bindings ?? []).map((entry) => entry.name);
  if (new Set(durableObjects).size !== durableObjects.length) {
    throw new Error("production Durable Object bindings must be unique");
  }
  for (const binding of RETIRED_FACT_BINDINGS) {
    if (durableObjects.includes(binding)) {
      throw new Error(`retired fact Durable Object remains bound: ${binding}`);
    }
  }
  const expectedDurableObjects = [...RETAINED_DO_BINDINGS].sort();
  if (JSON.stringify([...durableObjects].sort()) !== JSON.stringify(expectedDurableObjects)) {
    throw new Error("production Durable Object bindings differ from the retained coordination set");
  }

  const hyperdrives = new Map();
  for (const entry of config.hyperdrive ?? []) {
    if (!entry.binding || !entry.id) throw new Error("every production Hyperdrive needs binding and id");
    if (hyperdrives.has(entry.binding)) throw new Error(`duplicate Hyperdrive binding: ${entry.binding}`);
    if (!/^[0-9a-f]{32}$/u.test(entry.id)) throw new Error(`${entry.binding} has an invalid Hyperdrive id`);
    hyperdrives.set(entry.binding, entry.id);
  }
  if (hyperdrives.size !== PRODUCTION_HYPERDRIVE_BINDINGS.length) {
    throw new Error("production config must contain exactly two uncached Hyperdrive bindings");
  }
  const ids = new Set();
  for (const binding of PRODUCTION_HYPERDRIVE_BINDINGS) {
    const id = hyperdrives.get(binding);
    if (!id) throw new Error(`missing Hyperdrive binding: ${binding}`);
    if (ids.has(id)) throw new Error("production Hyperdrive ids must be distinct");
    ids.add(id);
  }
  return { schemaVersion: 1, hyperdrives: Object.fromEntries(hyperdrives) };
}

export function verifyProductionPostgresProvider(configSource, readbacks, source = process.env) {
  const config = verifyProductionPostgresConfig(configSource);
  const evidence = {};
  for (const [binding, expected] of Object.entries(productionHyperdrivePolicy(productionPostgresOrigin(source)))) {
    const actual = readbacks[binding];
    if (!actual) throw new Error(`missing provider readback for ${binding}`);
    if (actual.id !== config.hyperdrives[binding]) {
      throw new Error(`${binding} provider id does not match wrangler.toml`);
    }
    evidence[binding] = verifyProductionHyperdrive(actual, expected);
  }
  return { schemaVersion: 1, config: config.hyperdrives, provider: evidence };
}

export async function readProductionHyperdriveProvider(
  id,
  { source = process.env, fetchImpl = globalThis.fetch } = {},
) {
  if (!/^[0-9a-f]{32}$/u.test(id ?? "")) {
    throw new Error("Hyperdrive id is invalid");
  }
  const accountId = source.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const apiToken = source.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  if (!/^[0-9a-f]{32}$/u.test(accountId) || !apiToken) {
    throw new Error("Cloudflare Hyperdrive readback credentials are invalid");
  }
  const response = await fetchImpl(
    `${CLOUDFLARE_API_ROOT}/accounts/${accountId}/hyperdrive/configs/${id}`,
    { headers: { authorization: `Bearer ${apiToken}` } },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true || !payload.result) {
    const codes = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => error.code).filter(Boolean).join(",")
      : "unknown";
    throw new Error(`Cloudflare Hyperdrive readback failed (${response.status}; ${codes})`);
  }
  const actual = payload.result;
  return {
    id: actual.id,
    name: actual.name,
    origin: {
      scheme: actual.origin?.scheme,
      host: actual.origin?.host,
      port: actual.origin?.port,
      database: actual.origin?.database,
      user: actual.origin?.user,
    },
    caching: actual.caching,
    mtls: actual.mtls,
    origin_connection_limit: actual.origin_connection_limit,
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command, configPath, ...rest] = argv;
  if (command === "verify-config") {
    if (!configPath || rest.length !== 0) {
      throw new Error("usage: ... verify-config <config>");
    }
    const result = verifyProductionPostgresConfig(fs.readFileSync(configPath, "utf8"));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "read-provider") {
    if (!configPath || rest.length !== 0) {
      throw new Error("usage: ... read-provider <hyperdrive-id>");
    }
    const result = await readProductionHyperdriveProvider(configPath);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "binding-id") {
    const [binding] = rest;
    if (!configPath || !binding) throw new Error("usage: ... binding-id <config> <binding>");
    const result = verifyProductionPostgresConfig(fs.readFileSync(configPath, "utf8"));
    if (!result.hyperdrives[binding]) throw new Error(`unknown Hyperdrive binding: ${binding}`);
    process.stdout.write(`${result.hyperdrives[binding]}\n`);
    return;
  }
  if (command === "verify") {
    if (!configPath || rest.length !== 2) {
      throw new Error("usage: ... verify <config> <fresh-json> <shard-1-json>");
    }
    const bindings = PRODUCTION_HYPERDRIVE_BINDINGS;
    const readbacks = Object.fromEntries(bindings.map((binding, index) => [
      binding, parseHyperdriveReadback(fs.readFileSync(rest[index], "utf8")),
    ]));
    const result = verifyProductionPostgresProvider(fs.readFileSync(configPath, "utf8"), readbacks);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(
    "usage: production-postgres-config-policy.mjs <verify-config|read-provider|binding-id|verify> ...",
  );
}

runCliMain(import.meta.url, main);
