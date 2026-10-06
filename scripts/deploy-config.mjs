#!/usr/bin/env node
/**
 * Deployment profiles.
 *
 * The committed Wrangler configs (`packages/hub/wrangler*.toml`,
 * `apps/web/wrangler.jsonc`) describe the product: bindings, Durable Object
 * classes and migrations, and product flags. Everything that identifies one
 * deployment (Cloudflare account, domains, Hyperdrive and D1 ids, operator
 * emails and Space ids, cookie and mail identity) lives in a profile under
 * `deploy/profiles/<name>.json`. `render` merges the two into the config that
 * `wrangler deploy --config` uses; nothing deploys from the committed config
 * alone.
 *
 * Any profile string may instead be `{ "env": "NAME" }`, read from the
 * environment at render time, so a deployment can keep its ids out of files.
 *
 *   node scripts/deploy-config.mjs render <profile> [hub|web ...]
 *   node scripts/deploy-config.mjs env <profile>
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROFILE_SCHEMA_VERSION = 1;
export const COMPONENTS = ["hub", "web"];

const PROFILE_KEYS = new Set(["schemaVersion", "name", "cloudflare", "billing", "hub", "web"]);
const CLOUDFLARE_KEYS = new Set(["accountId"]);
const HUB_KEYS = new Set([
  "config", "workerName", "origin", "placementRegion", "workersDev", "previewUrls",
  "omitBindings", "hyperdrive", "d1", "vars",
]);
const WEB_KEYS = new Set([
  "config", "workerName", "origin", "workersDev", "previewUrls", "omitBindings",
]);
// URL and identity vars derived from profile fields, never set as raw vars.
const DERIVED_HUB_VARS = new Set(["APP_URL", "HUB_URL"]);

function fail(message) {
  throw new Error(`deploy profile: ${message}`);
}

function assertKnownKeys(value, allowed, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown key ${where}.${key}`);
  }
}

/** Resolves a literal string or `{ "env": NAME }` reference. */
export function resolveValue(value, where, env = process.env) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === 1 && typeof value.env === "string") {
    const resolved = env[value.env];
    if (typeof resolved !== "string" || resolved.trim() === "") {
      fail(`${where} reads ${value.env}, which is unset`);
    }
    return resolved.trim();
  }
  fail(`${where} must be a string or { "env": NAME }`);
}

function resolveOrigin(value, where, env) {
  const origin = resolveValue(value, where, env);
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail(`${where} is not a URL`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.port) {
    fail(`${where} must be a bare https origin`);
  }
  return { origin: url.origin, host: url.hostname };
}

function resolveMap(value, where, env, check) {
  if (value === undefined) return {};
  assertKnownKeys(value, new Set(Object.keys(value)), where);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = resolveValue(entry, `${where}.${key}`, env);
    check?.(out[key], `${where}.${key}`);
  }
  return out;
}

function hex32(value, where) {
  if (!/^[0-9a-f]{32}$/u.test(value)) fail(`${where} must be a 32-character hex id`);
}

export function profilePath(nameOrPath) {
  if (nameOrPath.endsWith(".json")) return resolve(nameOrPath);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(nameOrPath)) fail(`invalid profile name ${nameOrPath}`);
  return resolve(REPO_ROOT, "deploy", "profiles", `${nameOrPath}.json`);
}

export async function loadProfile(nameOrPath) {
  const path = profilePath(nameOrPath);
  if (!existsSync(path)) fail(`no profile at ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}

/** A billing package keeps its Hub policy at src/index.ts. */
function billingPackage(directory) {
  const hub = resolve(directory, "src/index.ts");
  if (!existsSync(hub)) fail(`billing names ${directory}, which has no src/index.ts`);
  return { directory, hub };
}

/** Validates a profile and resolves every env reference. */
export function resolveProfile(profile, env = process.env) {
  assertKnownKeys(profile, PROFILE_KEYS, "profile");
  if (profile.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${PROFILE_SCHEMA_VERSION}`);
  }
  if (typeof profile.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(profile.name)) {
    fail("name must be a lowercase slug");
  }
  assertKnownKeys(profile.cloudflare, CLOUDFLARE_KEYS, "cloudflare");
  const accountId = resolveValue(profile.cloudflare.accountId, "cloudflare.accountId", env);
  hex32(accountId, "cloudflare.accountId");

  // The package whose policy replaces @xmatrix/billing's, which meters nothing.
  const billing = profile.billing === undefined
    ? null : billingPackage(resolve(REPO_ROOT, resolveValue(profile.billing, "billing", env)));

  assertKnownKeys(profile.hub, HUB_KEYS, "hub");
  assertKnownKeys(profile.web, WEB_KEYS, "web");
  const hubOrigin = resolveOrigin(profile.hub.origin, "hub.origin", env);
  const webOrigin = resolveOrigin(profile.web.origin, "web.origin", env);

  const hubVars = resolveMap(profile.hub.vars, "hub.vars", env);
  for (const key of Object.keys(hubVars)) {
    if (DERIVED_HUB_VARS.has(key)) fail(`hub.vars.${key} is derived from the origins; remove it`);
  }
  const d1 = {};
  for (const [binding, entry] of Object.entries(profile.hub.d1 ?? {})) {
    assertKnownKeys(entry, new Set(["databaseId"]), `hub.d1.${binding}`);
    const databaseId = resolveValue(entry.databaseId, `hub.d1.${binding}.databaseId`, env);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(databaseId)) {
      fail(`hub.d1.${binding}.databaseId must be one D1 UUID`);
    }
    d1[binding] = { databaseId };
  }
  const placementRegion = profile.hub.placementRegion === undefined
    ? undefined
    : resolveValue(profile.hub.placementRegion, "hub.placementRegion", env);

  for (const component of ["hub", "web"]) {
    for (const key of ["workersDev", "previewUrls"]) {
      const value = profile[component][key];
      if (value !== undefined && typeof value !== "boolean") fail(`${component}.${key} must be a boolean`);
    }
  }
  for (const where of ["hub", "web"]) {
    const omit = profile[where].omitBindings ?? [];
    if (!Array.isArray(omit) || omit.some((name) => typeof name !== "string")) {
      fail(`${where}.omitBindings must be a list of binding names`);
    }
  }

  return {
    name: profile.name,
    accountId,
    billing,
    hub: {
      config: profile.hub.config ?? "packages/hub/wrangler.toml",
      workerName: resolveValue(profile.hub.workerName, "hub.workerName", env),
      ...hubOrigin,
      placementRegion,
      workersDev: profile.hub.workersDev,
      previewUrls: profile.hub.previewUrls,
      omitBindings: profile.hub.omitBindings ?? [],
      hyperdrive: resolveMap(profile.hub.hyperdrive, "hub.hyperdrive", env, hex32),
      d1,
      vars: hubVars,
    },
    web: {
      config: profile.web.config ?? "apps/web/wrangler.jsonc",
      workerName: resolveValue(profile.web.workerName, "web.workerName", env),
      ...webOrigin,
      workersDev: profile.web.workersDev,
      previewUrls: profile.web.previewUrls,
      omitBindings: profile.web.omitBindings ?? [],
    },
  };
}

const DEPLOYMENT_KEYS = ["account_id", "routes", "placement", "workers_dev", "preview_urls"];

function assertNoDeploymentIdentity(config, where) {
  for (const key of DEPLOYMENT_KEYS) {
    if (key in config) fail(`${where} must not set ${key}; it belongs in the profile`);
  }
}

function omitBindings(config, omit, where) {
  const known = new Set();
  for (const key of ["r2_buckets", "hyperdrive", "d1_databases", "analytics_engine_datasets", "send_email"]) {
    if (!Array.isArray(config[key])) continue;
    for (const entry of config[key]) known.add(entry.binding ?? entry.name);
    config[key] = config[key].filter((entry) => !omit.includes(entry.binding ?? entry.name));
    if (config[key].length === 0) delete config[key];
  }
  for (const name of omit) {
    if (!known.has(name)) fail(`${where}.omitBindings names unknown binding ${name}`);
  }
}

/** Merges a resolved profile into the committed Hub config. */
export function renderHubConfig(base, resolved) {
  const hub = resolved.hub;
  const config = structuredClone(base);
  assertNoDeploymentIdentity(config, hub.config);
  for (const key of Object.keys(config.vars ?? {})) {
    if (DERIVED_HUB_VARS.has(key) || key in hub.vars) {
      fail(`${hub.config} sets deployment var ${key}; it belongs in the profile`);
    }
  }
  omitBindings(config, hub.omitBindings, "hub");

  const rendered = {
    name: hub.workerName,
    account_id: resolved.accountId,
    ...Object.fromEntries(Object.entries(config).filter(([key]) => key !== "name")),
  };
  if (hub.placementRegion) rendered.placement = { region: hub.placementRegion };
  if (hub.workersDev !== undefined) rendered.workers_dev = hub.workersDev;
  if (hub.previewUrls !== undefined) rendered.preview_urls = hub.previewUrls;
  rendered.routes = [{ pattern: hub.host, custom_domain: true }];
  if (resolved.billing) rendered.alias = { ...config.alias, "@xmatrix/billing": resolved.billing.hub };

  const unusedHyperdrive = new Set(Object.keys(hub.hyperdrive));
  for (const entry of rendered.hyperdrive ?? []) {
    if ("id" in entry) fail(`${hub.config} sets a Hyperdrive id for ${entry.binding}; it belongs in the profile`);
    const id = hub.hyperdrive[entry.binding];
    if (!id) fail(`hub.hyperdrive.${entry.binding} is required`);
    entry.id = id;
    unusedHyperdrive.delete(entry.binding);
  }
  if (unusedHyperdrive.size) fail(`hub.hyperdrive has unknown bindings ${[...unusedHyperdrive].join(", ")}`);

  const unusedD1 = new Set(Object.keys(hub.d1));
  for (const entry of rendered.d1_databases ?? []) {
    const database = hub.d1[entry.binding];
    if (!database) fail(`hub.d1.${entry.binding} is required`);
    entry.database_id = database.databaseId;
    if (entry.migrations_dir) entry.migrations_dir = resolve(REPO_ROOT, dirname(hub.config), entry.migrations_dir);
    unusedD1.delete(entry.binding);
  }
  if (unusedD1.size) fail(`hub.d1 has unknown bindings ${[...unusedD1].join(", ")}`);

  rendered.vars = {
    ...config.vars,
    ...hub.vars,
    APP_URL: resolved.web.origin,
    HUB_URL: hub.origin,
  };
  return rendered;
}

/** Merges a resolved profile into the committed Web config. */
export function renderWebConfig(base, resolved) {
  const web = resolved.web;
  const config = structuredClone(base);
  delete config.$schema;
  assertNoDeploymentIdentity(config, web.config);
  omitBindings(config, web.omitBindings, "web");
  return {
    name: web.workerName,
    account_id: resolved.accountId,
    ...Object.fromEntries(Object.entries(config).filter(([key]) => key !== "name")),
    ...(web.workersDev === undefined ? {} : { workers_dev: web.workersDev }),
    ...(web.previewUrls === undefined ? {} : { preview_urls: web.previewUrls }),
    routes: [{ pattern: web.host, custom_domain: true }],
  };
}

function parseJsonc(source) {
  return JSON.parse(source.replace(/^\s*\/\/.*$/gmu, ""));
}

/** Path of the rendered config, next to the committed one so relative paths hold. */
export function renderedConfigPath(component, resolved) {
  const config = resolved[component].config;
  const extension = component === "hub" ? "toml" : "json";
  return resolve(REPO_ROOT, dirname(config), `wrangler.generated.${resolved.name}.${extension}`);
}

export async function renderComponent(component, resolved) {
  const basePath = resolve(REPO_ROOT, resolved[component].config);
  const source = await readFile(basePath, "utf8");
  if (component === "hub") {
    const { parse, stringify } = await import("smol-toml");
    return `${stringify(renderHubConfig(parse(source), resolved))}\n`;
  }
  return `${JSON.stringify(renderWebConfig(parseJsonc(source), resolved), null, 2)}\n`;
}

/** Shell-style KEY=VALUE lines other steps read (for example via $GITHUB_ENV). */
export function profileEnvironment(resolved) {
  return {
    XMATRIX_DEPLOY_PROFILE: resolved.name,
    XMATRIX_APP_ORIGIN: resolved.web.origin,
    XMATRIX_HUB_ORIGIN: resolved.hub.origin,
    XMATRIX_HUB_CONFIG: renderedConfigPath("hub", resolved),
    XMATRIX_WEB_CONFIG: renderedConfigPath("web", resolved),
    NEXT_PUBLIC_APP_URL: resolved.web.origin,
    NEXT_PUBLIC_AUTH_BASE_URL: resolved.hub.origin,
    NEXT_PUBLIC_XMATRIX_HUB_URL: resolved.hub.origin,
  };
}

async function main(argv) {
  const [command, profileName, ...rest] = argv;
  if (!command || !profileName || !["render", "env", "origin"].includes(command)) {
    throw new Error("Usage: node scripts/deploy-config.mjs render|env|origin <profile> [hub|web ...]");
  }
  // A public origin alone, without the deployment identity the rest of the profile reads from secrets.
  if (command === "origin") {
    const [component] = rest;
    if (!COMPONENTS.includes(component)) throw new Error(`unknown component ${component}`);
    const profile = await loadProfile(profileName);
    process.stdout.write(`${resolveOrigin(profile[component]?.origin, `${component}.origin`, process.env).origin}\n`);
    return;
  }
  const resolved = resolveProfile(await loadProfile(profileName));
  if (command === "env") {
    for (const [key, value] of Object.entries(profileEnvironment(resolved))) {
      process.stdout.write(`${key}=${value}\n`);
    }
    return;
  }
  const components = rest.length ? rest : COMPONENTS;
  for (const component of components) {
    if (!COMPONENTS.includes(component)) throw new Error(`unknown component ${component}`);
    const output = renderedConfigPath(component, resolved);
    await writeFile(output, await renderComponent(component, resolved), { mode: 0o600 });
    process.stderr.write(`rendered ${component} → ${output}\n`);
  }
}

if (basename(process.argv[1] ?? "") === "deploy-config.mjs") {
  await main(process.argv.slice(2));
}
