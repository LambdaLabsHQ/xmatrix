import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  PRODUCTION_POSTGRES_AUTHORITY_SELECTORS,
  readProductionHyperdriveProvider,
  verifyProductionPostgresConfig,
  verifyProductionPostgresProvider,
} from "./production-postgres-config-policy.mjs";

// The release step reads the reviewed origin from the production environment.
process.env.XMATRIX_POSTGRES_ORIGIN = "203.0.113.10:10016";

const ids = {
  RELAY_POSTGRES: "1".repeat(32),
  RELAY_POSTGRES_SHARD_1: "3".repeat(32),
};

function config(overrides = "") {
  const selectors = PRODUCTION_POSTGRES_AUTHORITY_SELECTORS
    .map((name) => `${name} = "postgres"`).join("\n");
  return `
[durable_objects]
bindings = [
  { name = "RELAY_SUMMON_DECISION_CLOCK", class_name = "E" },
  { name = "RELAY_SPACE_DELETION_CLOCK", class_name = "F" },
  { name = "RELAY_PAGE_SESSION", class_name = "H" },
  { name = "RELAY_SCOPED_CONTROL_AUTHORITY", class_name = "A" },
  { name = "RELAY_CHANNEL_FAMILY_DATA", class_name = "A" },
  { name = "RELAY_CHANNEL_FAMILY_DIRECTORY", class_name = "A" },
  { name = "RELAY_POSTGRES_CHANNEL_COORDINATOR", class_name = "A" },
  { name = "RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL", class_name = "D" },
  { name = "RELAY_POSTGRES_BACKGROUND_ADMISSION", class_name = "G" },
  { name = "RELAY_CONTROL_PLANE_DIRECTORY", class_name = "A" },
  { name = "RELAY_RANK_AUTHORITY_DIRECTORY", class_name = "A" },
  { name = "RELAY_GLOBAL_DIRECTORY_AUTHORITY", class_name = "A" },
  { name = "RELAY_AGENT_APP_POLICY_LOCATOR", class_name = "A" },
  { name = "RELAY_SPACE_PROJECTION", class_name = "A" },
  { name = "RELAY_SPACE_CAPACITY_AUTHORITY", class_name = "A" },
  { name = "RELAY_RUNTIME", class_name = "A" },
  { name = "RELAY_RUNTIME_ROUTE_DIRECTORY", class_name = "A" },
  { name = "RELAY_RUNTIME_CHANNEL_FANOUT", class_name = "A" },
  { name = "GITHUB_SUBSCRIPTION_INDEX", class_name = "A" },
  { name = "DEVICE_AUTH", class_name = "A" }
]
[[hyperdrive]]
binding = "RELAY_POSTGRES"
id = "${ids.RELAY_POSTGRES}"
[[hyperdrive]]
binding = "RELAY_POSTGRES_SHARD_1"
id = "${ids.RELAY_POSTGRES_SHARD_1}"
[vars]
${selectors}
RELAY_POSTGRES_SHARD_ID = "shard-0"
RELAY_POSTGRES_SHARD_1_ID = "shard-1"
${overrides}`;
}

function readback(binding) {
  const shard = binding === "RELAY_POSTGRES_SHARD_1";
  return {
    id: ids[binding],
    name: shard ? "xmatrix-prod-shard-1-fresh" : "xmatrix-prod-fresh",
    origin: {
      scheme: "postgresql", host: "203.0.113.10", port: 10016,
      database: shard ? "xmatrix_prod_shard_1" : "xmatrix_prod",
      user: shard ? "xmatrix_prod_shard_1_runtime" : "xmatrix_prod_runtime",
    },
    caching: { disabled: true },
    mtls: { sslmode: "require" },
    origin_connection_limit: shard ? 8 : 24,
  };
}

test("production config selects PostgreSQL for every fact domain", () => {
  assert.deepEqual(verifyProductionPostgresConfig(config()).hyperdrives, ids);
  assert.throws(() => verifyProductionPostgresConfig(`${config()}\n[[hyperdrive]]\nbinding = "RELAY_POSTGRES_CACHED"\nid = "${"2".repeat(32)}"`), /exactly two uncached Hyperdrive bindings/u);
});

test("production config rejects unterminated comments without hanging the release", () => {
  // A child process bounds the regression: vulnerable smol-toml loops forever
  // synchronously, so a test timeout in the same process cannot interrupt it.
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { verifyProductionPostgresConfig } from ${JSON.stringify(new URL("./production-postgres-config-policy.mjs", import.meta.url).href)};
    for (const source of ["a=[1 #", "a={b=1 #"]) {
      assert.throws(() => verifyProductionPostgresConfig(source), /production config is not valid TOML/);
    }
  `], { encoding: "utf8", timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("production config rejects D1 and retired fact Durable Object bindings", () => {
  assert.throws(() => verifyProductionPostgresConfig(`${config()}\n[[d1_databases]]\nbinding = "AUTH_DB"`),
    /AUTH_DB\/D1/u);
  assert.throws(() => verifyProductionPostgresConfig(config().replace(
    '  { name = "DEVICE_AUTH", class_name = "A" }',
    '  { name = "DEVICE_AUTH", class_name = "A" },\n  { name = "RELAY_USER_PREFERENCE_AUTHORITY", class_name = "A" }',
  )), /retired fact Durable Object/u);
  assert.throws(() => verifyProductionPostgresConfig(config().replace(
    '  { name = "DEVICE_AUTH", class_name = "A" }',
    '  { name = "DEVICE_AUTH", class_name = "A" },\n  { name = "UNKNOWN_FACT_DO", class_name = "A" }',
  )), /retained coordination set/u);
});

test("production config rejects selector and Hyperdrive drift", () => {
  assert.throws(() => verifyProductionPostgresConfig(
    config().replace('AUTH_AUTHORITY = "postgres"', 'AUTH_AUTHORITY = "d1"'),
  ), /AUTH_AUTHORITY/u);
  assert.throws(() => verifyProductionPostgresConfig(
    config().replace(ids.RELAY_POSTGRES_SHARD_1, ids.RELAY_POSTGRES),
  ), /must be distinct/u);
});

test("provider readback must match config, origin, TLS, and cache policy", () => {
  const readbacks = Object.fromEntries(Object.keys(ids).map((binding) => [binding, readback(binding)]));
  const evidence = verifyProductionPostgresProvider(config(), readbacks);
  assert.equal(JSON.stringify(evidence).includes("password"), false);
  assert.throws(() => verifyProductionPostgresProvider(config(), {
    ...readbacks,
    RELAY_POSTGRES_SHARD_1: { ...readbacks.RELAY_POSTGRES_SHARD_1, id: "4".repeat(32) },
  }), /does not match wrangler.toml/u);
  assert.throws(() => verifyProductionPostgresProvider(config(), {
    ...readbacks,
    RELAY_POSTGRES: { ...readbacks.RELAY_POSTGRES, origin: {
      ...readbacks.RELAY_POSTGRES.origin, database: "wrong",
    } },
  }), /origin.database/u);
});

test("provider readback uses the Cloudflare API and strips credential fields", async () => {
  const expected = readback("RELAY_POSTGRES");
  const calls = [];
  const result = await readProductionHyperdriveProvider(expected.id, {
    source: {
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        success: true,
        result: { ...expected, origin: { ...expected.origin, password: "secret" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`/accounts/${"a".repeat(32)}/hyperdrive/configs/${expected.id}$`, "u"));
  assert.equal(calls[0].init.headers.authorization, "Bearer token");
});

test("every binding rejects provider drift against the reviewed production policy", () => {
  const readbacks = Object.fromEntries(Object.keys(ids).map((binding) => [binding, readback(binding)]));
  for (const binding of Object.keys(ids)) {
    for (const [path, value] of [
      [["name"], "wrong"],
      [["origin", "scheme"], "mysql"],
      [["origin", "host"], "198.51.100.20"],
      [["origin", "port"], 10026],
      [["origin", "database"], "wrong"],
      [["origin", "user"], "admin"],
      [["mtls", "sslmode"], "disable"],
      [["origin_connection_limit"], 1],
      [["caching", "disabled"], !readbacks[binding].caching.disabled],
    ]) {
      const changed = structuredClone(readbacks);
      const target = path.length === 1 ? changed[binding] : changed[binding][path[0]];
      target[path.at(-1)] = value;
      assert.throws(() => verifyProductionPostgresProvider(config(), changed),
        (error) => error.message.startsWith(`${path.join(".")} is `), `${binding}: ${path.join(".")}`);
    }
  }
});

test("provider readback fails closed on Cloudflare API errors", async () => {
  await assert.rejects(() => readProductionHyperdriveProvider("1".repeat(32), {
    source: {
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "token",
    },
    fetchImpl: async () => new Response(JSON.stringify({
      success: false,
      errors: [{ code: 9109 }],
    }), { status: 403, headers: { "content-type": "application/json" } }),
  }), /403; 9109/u);
});
