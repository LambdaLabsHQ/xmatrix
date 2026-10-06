import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "smol-toml";
import { loadProfile, renderComponent, resolveProfile } from "./deploy-config.mjs";

const TEST_D1_ID = "11111111-2222-3333-8444-555555555555";
// Deployment identity comes from the environment's secrets; these stand in for them.
const env = {
  TEST_AUTH_D1_DATABASE_ID: TEST_D1_ID,
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  XMATRIX_HYPERDRIVE_ID: "11111111111111111111111111111111",
  XMATRIX_HYPERDRIVE_SHARD_1_ID: "22222222222222222222222222222222",
  XMATRIX_PLATFORM_ADMIN_EMAILS: "admin@example.com",
  XMATRIX_PLATFORM_ADMIN_SPACE_ID: "33333333-4444-4555-8666-777777777777",
  XMATRIX_RUNTIME_LOCATION_HINT: "apac",
};
const production = resolveProfile(await loadProfile("production"), env);
const cloudTest = resolveProfile(await loadProfile("test"), env);

const rendered = {
  productionHub: await renderComponent("hub", production),
  testHub: await renderComponent("hub", cloudTest),
  productionWeb: JSON.parse(await renderComponent("web", production)),
  testWeb: JSON.parse(await renderComponent("web", cloudTest)),
};
const hub = {
  production: parse(rendered.productionHub),
  test: parse(rendered.testHub),
  local: parse(await readFile(new URL("../packages/hub/wrangler.test.toml", import.meta.url), "utf8")),
};

const binding = (config, key, name) => config[key]?.find((entry) => (entry.binding ?? entry.name) === name);

test("cloud test deployment has a complete isolated resource inventory", () => {
  const config = hub.test;
  assert.equal(config.name, "xmatrix-hub-test");
  assert.deepEqual(config.routes, [{ pattern: "xmatrix-hub.test.xmatrix.sh", custom_domain: true }]);
  assert.equal(config.placement, undefined);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  const d1 = binding(config, "d1_databases", "AUTH_DB");
  assert.equal(d1.database_name, "xmatrix-auth-test");
  assert.equal(d1.database_id, TEST_D1_ID);
  assert.match(d1.migrations_dir, /\/packages\/hub\/migrations$/u);
  assert.equal(binding(config, "r2_buckets", "ATTACHMENT_BUCKET").bucket_name, "xmatrix-attachments-test");
  assert.equal(binding(config, "r2_buckets", "RELAY_PAYLOAD_BUCKET").bucket_name, "xmatrix-relay-v2-test");
  assert.equal(config.queues, undefined);
  assert.equal(binding(config, "analytics_engine_datasets", "DIAGNOSTICS_AE").dataset, "xmatrix_diagnostics_test");
  assert.equal(
    binding(config, "analytics_engine_datasets", "RELAY_AUTHORITY_OBSERVABILITY_AE").dataset,
    "xmatrix_relay_authority_observability_test",
  );
  assert.equal(config.version_metadata.binding, "CF_VERSION_METADATA");
  assert.equal(config.vars.RELAY_AUTHORITY_OBSERVABILITY_ENABLED, "true");
  assert.equal(config.vars.AUTH_COOKIE_DOMAIN, ".test.xmatrix.sh");
  assert.equal(config.vars.AUTH_COOKIE_PREFIX, "xmatrix-test");
  assert.equal(config.vars.APP_URL, "https://test.xmatrix.sh");
  assert.equal(config.vars.HUB_URL, "https://xmatrix-hub.test.xmatrix.sh");
});

test("the official deployments bundle the official billing policy", () => {
  for (const resolved of [production, cloudTest]) {
    assert.match(resolved.billing.hub, /\/packages\/billing-official\/src\/index\.ts$/u, resolved.name);
  }
  assert.equal(hub.production.alias["@xmatrix/billing"], production.billing.hub);
});

test("production configuration cannot enable mock auth or reference test resources", () => {
  const config = hub.production;
  assert.equal(Object.keys(config.vars).some((key) => key.startsWith("XMATRIX_MOCK_AUTH")), false);
  assert.doesNotMatch(rendered.productionHub, /(?:^|[-._"])test(?:[-._"]|$)/u);
  assert.equal(config.vars.AUTH_COOKIE_DOMAIN, ".xmatrix.sh");
  assert.deepEqual(config.placement, { region: "aws:ap-southeast-1" });
  assert.deepEqual(config.routes, [{ pattern: "xmatrix-hub.xmatrix.sh", custom_domain: true }]);
  assert.equal(config.vars.APP_URL, "https://xmatrix.sh");
  assert.equal(config.vars.HUB_URL, "https://xmatrix-hub.xmatrix.sh");
});

test("production and the cloud test deployment share no bucket", () => {
  const buckets = (config) => (config.r2_buckets ?? []).map((entry) => entry.bucket_name);
  assert.deepEqual(buckets(hub.production).filter((name) => buckets(hub.test).includes(name)), []);
});

test("local E2E and long-lived cloud test configurations remain distinct", () => {
  assert.equal(binding(hub.local, "d1_databases", "AUTH_DB").database_id, "00000000-0000-0000-0000-000000000000");
  assert.doesNotMatch(JSON.stringify(hub.local), /xmatrix-hub\.test\.xmatrix\.sh/u);
  assert.doesNotMatch(rendered.testHub, /00000000-0000-0000-0000-000000000000/u);
});

test("web custom domains are isolated and non-production previews are disabled", () => {
  assert.equal(rendered.productionWeb.name, "xmatrix-web");
  assert.deepEqual(rendered.productionWeb.routes, [{ pattern: "xmatrix.sh", custom_domain: true }]);
  assert.equal(rendered.testWeb.name, "xmatrix-web-test");
  assert.deepEqual(rendered.testWeb.routes, [{ pattern: "test.xmatrix.sh", custom_domain: true }]);
  assert.equal(rendered.testWeb.workers_dev, false);
  assert.equal(rendered.testWeb.preview_urls, false);
  assert.equal(rendered.testWeb.r2_buckets, undefined);
});
