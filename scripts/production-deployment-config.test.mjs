import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { loadProfile, renderComponent, resolveProfile } from "./deploy-config.mjs";

// Deployment identity comes from the environment's secrets; these stand in for them.
const env = {
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  XMATRIX_HYPERDRIVE_ID: "11111111111111111111111111111111",
  XMATRIX_HYPERDRIVE_SHARD_1_ID: "22222222222222222222222222222222",
  XMATRIX_PLATFORM_ADMIN_EMAILS: "admin@example.com",
  XMATRIX_PLATFORM_ADMIN_SPACE_ID: "33333333-4444-4555-8666-777777777777",
  XMATRIX_RUNTIME_LOCATION_HINT: "apac",
};
const production = resolveProfile(await loadProfile("production"), env);
const renderedHub = await renderComponent("hub", production);
const hub = parse(renderedHub);
const web = JSON.parse(await renderComponent("web", production));

const binding = (config, key, name) => config[key]?.find((entry) => (entry.binding ?? entry.name) === name);

test("production bundles the official billing policy", () => {
  assert.match(production.billing.hub, /\/packages\/billing-official\/src\/index\.ts$/u);
  assert.equal(hub.alias["@xmatrix/billing"], production.billing.hub);
});

test("production configuration cannot enable mock auth or reference test resources", () => {
  assert.equal(Object.keys(hub.vars).some((key) => key.startsWith("XMATRIX_MOCK_AUTH")), false);
  assert.doesNotMatch(renderedHub, /(?:^|[-._"])test(?:[-._"]|$)/u);
  assert.equal(hub.vars.AUTH_COOKIE_DOMAIN, ".xmatrix.sh");
  assert.deepEqual({ ...hub.placement }, { region: "aws:ap-southeast-1" });
  assert.deepEqual(hub.routes.map((route) => ({ ...route })), [{ pattern: "xmatrix-hub.xmatrix.sh", custom_domain: true }]);
  assert.equal(hub.vars.APP_URL, "https://xmatrix.sh");
  assert.equal(hub.vars.APP_BETA_URL, "https://beta.xmatrix.sh");
  assert.equal(hub.vars.HUB_URL, "https://xmatrix-hub.xmatrix.sh");
  assert.equal(binding(hub, "analytics_engine_datasets", "XMATRIX_USAGE_COST_AE").dataset, "xmatrix_usage_cost");
});

test("production refuses over-limit requests and bounds Jev spend, each limiter in its own namespace", () => {
  assert.equal(hub.vars.RATE_LIMIT_ENFORCED, "true");
  // A missing binding admits everything, so a dropped one silently lifts a spend bound.
  for (const name of ["RATE_LIMIT_SUMMON_INTENT", "RATE_LIMIT_JEV_EVALUATE", "RATE_LIMIT_SEARCH_RERANK"]) {
    assert.ok(binding(hub, "ratelimits", name), name);
  }
  const namespaces = hub.ratelimits.map((limiter) => limiter.namespace_id);
  assert.equal(new Set(namespaces).size, namespaces.length, "limiters sharing a namespace share counters");
});

test("production Web serves its custom domain", () => {
  assert.equal(web.name, "xmatrix-web");
  assert.deepEqual(web.routes, [{ pattern: "xmatrix.sh", custom_domain: true }]);
});

test("the production beta Web is its own Worker on beta.xmatrix.sh, with no other public host", async () => {
  const beta = JSON.parse(await renderComponent("web-beta", production));
  assert.equal(beta.name, "xmatrix-web-beta");
  assert.deepEqual(beta.routes, [{ pattern: "beta.xmatrix.sh", custom_domain: true }]);
  assert.equal(beta.workers_dev, false);
  assert.equal(beta.preview_urls, false);
});
