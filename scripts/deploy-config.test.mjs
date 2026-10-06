import assert from "node:assert/strict";
import { test } from "node:test";
import {
  profileEnvironment,
  renderHubConfig,
  renderWebConfig,
  resolveProfile,
} from "./deploy-config.mjs";

function profile(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "selfhost",
    cloudflare: { accountId: "0123456789abcdef0123456789abcdef" },
    hub: {
      workerName: "acme-hub",
      origin: "https://hub.acme.example",
      hyperdrive: { RELAY_POSTGRES: { env: "ACME_HYPERDRIVE" } },
      vars: { AUTH_COOKIE_DOMAIN: ".acme.example" },
      ...overrides.hub,
    },
    web: { workerName: "acme-web", origin: "https://acme.example", ...overrides.web },
    ...overrides.top,
  };
}

const env = { ACME_HYPERDRIVE: "fedcba9876543210fedcba9876543210" };
const hubBase = {
  name: "xmatrix-hub",
  main: "src/index.ts",
  hyperdrive: [{ binding: "RELAY_POSTGRES" }],
  r2_buckets: [{ binding: "ATTACHMENT_BUCKET", bucket_name: "xmatrix-attachments" }, { binding: "OPTIONAL", bucket_name: "x" }],
  vars: { PRODUCT_FLAG: "true" },
};

test("renders deployment identity from the profile and env references", () => {
  const resolved = resolveProfile(profile({ hub: { omitBindings: ["OPTIONAL"] } }), env);
  const hub = renderHubConfig(hubBase, resolved);
  assert.equal(hub.name, "acme-hub");
  assert.equal(hub.account_id, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(hub.routes, [{ pattern: "hub.acme.example", custom_domain: true }]);
  assert.deepEqual(hub.hyperdrive, [{ binding: "RELAY_POSTGRES", id: env.ACME_HYPERDRIVE }]);
  assert.deepEqual(hub.r2_buckets.map((entry) => entry.binding), ["ATTACHMENT_BUCKET"]);
  assert.deepEqual(hub.vars, {
    PRODUCT_FLAG: "true",
    AUTH_COOKIE_DOMAIN: ".acme.example",
    APP_URL: "https://acme.example",
    HUB_URL: "https://hub.acme.example",
  });
  assert.equal("placement" in hub, false);
  assert.equal("workers_dev" in hub, false);

  const web = renderWebConfig({ name: "xmatrix-web", main: "worker.mjs" }, resolved);
  assert.deepEqual(web, {
    name: "acme-web",
    account_id: "0123456789abcdef0123456789abcdef",
    main: "worker.mjs",
    routes: [{ pattern: "acme.example", custom_domain: true }],
  });
  assert.equal(profileEnvironment(resolved).NEXT_PUBLIC_XMATRIX_HUB_URL, "https://hub.acme.example");
});

test("fails closed on missing or conflicting deployment identity", () => {
  assert.throws(() => resolveProfile(profile(), {}), /ACME_HYPERDRIVE, which is unset/u);
  assert.throws(() => resolveProfile(profile({ top: { extra: 1 } }), env), /unknown key profile.extra/u);
  assert.throws(() => resolveProfile(profile({ hub: { origin: "http://hub.acme.example" } }), env), /bare https origin/u);
  assert.throws(() => resolveProfile(profile({ hub: { vars: { APP_URL: "x" } } }), env), /derived from the origins/u);
  assert.throws(
    () => resolveProfile(profile({ hub: { d1: { AUTH_DB: { databaseId: "not-a-uuid" } } } }), env),
    /one D1 UUID/u,
  );

  const resolved = resolveProfile(profile(), env);
  assert.throws(() => renderHubConfig({ ...hubBase, account_id: "a" }, resolved), /must not set account_id/u);
  assert.throws(() => renderHubConfig({ ...hubBase, vars: { AUTH_COOKIE_DOMAIN: "x" } }, resolved), /deployment var AUTH_COOKIE_DOMAIN/u);
  assert.throws(
    () => renderHubConfig({ ...hubBase, hyperdrive: [{ binding: "RELAY_POSTGRES", id: "x" }] }, resolved),
    /sets a Hyperdrive id/u,
  );
  assert.throws(
    () => renderHubConfig({ ...hubBase, hyperdrive: [...hubBase.hyperdrive, { binding: "OTHER" }] }, resolved),
    /hub.hyperdrive.OTHER is required/u,
  );
  assert.throws(
    () => renderHubConfig(hubBase, resolveProfile(profile({ hub: { omitBindings: ["NOPE"] } }), env)),
    /unknown binding NOPE/u,
  );
});

test("a deployment meters nothing unless its profile names a billing policy", () => {
  const unmetered = resolveProfile(profile(), env);
  assert.equal(unmetered.billing, null);
  assert.equal(renderHubConfig(hubBase, unmetered).alias, undefined);

  const metered = resolveProfile(profile({ top: { billing: "packages/billing" } }), env);
  assert.match(metered.billing.hub, /\/packages\/billing\/src\/index\.ts$/u);
  assert.deepEqual(renderHubConfig(hubBase, metered).alias, { "@xmatrix/billing": metered.billing.hub });

  assert.throws(() => resolveProfile(profile({ top: { billing: "packages/no-such-billing" } }), env),
    /billing names .*no-such-billing, which has no src\/index\.ts/u);
});
