import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHyperdriveReadback,
  verifyHyperdriveCachePolicy,
} from "./hyperdrive-cache-policy.mjs";

function configs() {
  const origin = {
    host: "postgres.invalid",
    port: 5432,
    database: "xmatrix_next",
    scheme: "postgresql",
    user: "xmatrix_next_app",
  };
  return {
    freshId: "fresh-id",
    cachedId: "cached-id",
    fresh: {
      id: "fresh-id",
      name: "xmatrix-next-fresh",
      origin,
      origin_connection_limit: 20,
      caching: { disabled: true },
      mtls: { sslmode: "require" },
    },
    cached: {
      id: "cached-id",
      name: "xmatrix-next-cached",
      origin: { ...origin },
      origin_connection_limit: 5,
      caching: { disabled: false, max_age: 5 },
      mtls: { sslmode: "require" },
    },
  };
}

test("reviewed Hyperdrive pair has one TLS origin and isolated cache policies", () => {
  assert.doesNotThrow(() => verifyHyperdriveCachePolicy(configs()));
});

test("fresh cache enablement, cached drift, and origin drift fail closed", () => {
  for (const mutate of [
    (value) => { value.fresh.caching.disabled = false; },
    (value) => { value.cached.caching.max_age = 60; },
    (value) => { value.cached.origin.database = "other"; },
    (value) => { value.fresh.mtls.sslmode = "disable"; },
    (value) => { value.fresh.origin_connection_limit = 5; },
    (value) => { value.cached.origin_connection_limit = 20; },
  ]) {
    const value = configs();
    mutate(value);
    assert.throws(() => verifyHyperdriveCachePolicy(value));
  }
});

test("Wrangler banners around a Hyperdrive object do not hide provider readback", () => {
  const fresh = configs().fresh;
  assert.deepEqual(
    parseHyperdriveReadback(`\n ⛅️ wrangler 4.79.0\n${JSON.stringify(fresh)}\ntelemetry disabled\n`),
    fresh,
  );
  assert.throws(() => parseHyperdriveReadback("wrangler produced no config"));
});
