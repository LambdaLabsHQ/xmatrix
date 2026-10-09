import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.cloudflare.com/client/v4";
/**
 * The production PostgreSQL origin, `host:port`, from the production
 * environment's XMATRIX_POSTGRES_ORIGIN secret: Hyperdrive must point there
 * and nowhere else.
 */
export function productionPostgresOrigin(source = process.env) {
  const value = source.XMATRIX_POSTGRES_ORIGIN?.trim() ?? "";
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/u.exec(value);
  if (!match) throw new Error("XMATRIX_POSTGRES_ORIGIN must be host:port");
  return { host: match[1], port: match[2] };
}

export const PRODUCTION_HYPERDRIVE_BINDINGS = Object.freeze(["RELAY_POSTGRES", "RELAY_POSTGRES_SHARD_1"]);

/**
 * PlanetScale routes a login by a branch suffix on the user name
 * (`role.branch`); the session's role is the part before it.
 */
export function originUserMatches(actual, role) {
  return typeof actual === "string" && (actual === role || new RegExp(`^${role}\\.[a-z0-9]+$`, "u").test(actual));
}

// Credential-free expectations shared by preparation and release readback.
// Both shards share one PlanetScale origin with max_connections 50 (3 kept for
// superusers); the provider's own admin and exporter sessions hold about 4 more.
// Hyperdrive's limits are soft: on 2026-10-08 the primary pool held 36 against
// a limit of 30, which with 40 configured left no slot for release verification
// or migrations. The limits total 32 so an overshoot of that size still fits.
export function productionHyperdrivePolicy(expectedOrigin = productionPostgresOrigin()) {
  const origin = {
    scheme: "postgresql", host: expectedOrigin.host, port: Number(expectedOrigin.port),
    database: "xmatrix_prod", user: "xmatrix_prod_runtime",
  };
  return {
    RELAY_POSTGRES: {
      name: "xmatrix-prod-fresh",
      origin: { ...origin },
      caching: { disabled: true }, mtls: { sslmode: "require" },
      origin_connection_limit: 24,
    },
    RELAY_POSTGRES_SHARD_1: {
      name: "xmatrix-prod-shard-1-fresh",
      origin: { ...origin, database: "xmatrix_prod_shard_1", user: "xmatrix_prod_shard_1_runtime" },
      caching: { disabled: true }, mtls: { sslmode: "require" },
      origin_connection_limit: 8,
    },
  };
}

function required(source, name) {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databaseOrigin(source, name, expected) {
  const value = new URL(required(source, name));
  if (value.protocol !== "postgresql:" && value.protocol !== "postgres:") {
    throw new Error(`${name} must use PostgreSQL`);
  }
  if (value.hostname !== expected.host || value.port !== String(expected.port)) {
    throw new Error(`${name} must target the reviewed production origin`);
  }
  if (decodeURIComponent(value.pathname.slice(1)) !== expected.database) {
    throw new Error(`${name} targets an unexpected database`);
  }
  const user = decodeURIComponent(value.username);
  if (!originUserMatches(user, expected.user)) {
    throw new Error(`${name} uses an unexpected role`);
  }
  const password = decodeURIComponent(value.password);
  if (!password) throw new Error(`${name} has no password`);
  return { ...expected, user, password };
}

export function desiredProductionHyperdrives(source = process.env, expectedOrigin = productionPostgresOrigin(source)) {
  const policy = productionHyperdrivePolicy(expectedOrigin);
  const accountId = required(source, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = required(source, "CLOUDFLARE_API_TOKEN");
  if (!/^[0-9a-f]{32}$/u.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is invalid");
  }
  const primary = databaseOrigin(
    source, "POSTGRES_RUNTIME_DATABASE_URL", policy.RELAY_POSTGRES.origin,
  );
  const shard = databaseOrigin(
    source, "POSTGRES_SHARD_1_RUNTIME_DATABASE_URL", policy.RELAY_POSTGRES_SHARD_1.origin,
  );
  return {
    accountId,
    apiToken,
    configs: [
      { ...policy.RELAY_POSTGRES, origin: primary },
      { ...policy.RELAY_POSTGRES_SHARD_1, origin: shard },
    ],
  };
}

async function cloudflare(fetchImpl, token, path, init = {}) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    const codes = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => error.code).filter(Boolean).join(",")
      : "unknown";
    throw new Error(`Cloudflare Hyperdrive request failed (${response.status}; ${codes})`);
  }
  return payload.result;
}

function exact(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

export function verifyProductionHyperdrive(actual, expected) {
  exact(actual.name, expected.name, "name");
  for (const key of ["scheme", "host", "port", "database"]) {
    exact(actual.origin?.[key], expected.origin[key], `origin.${key}`);
  }
  if (!originUserMatches(actual.origin?.user, expected.origin.user.replace(/\.[a-z0-9]+$/u, ""))) {
    throw new Error(`origin.user is ${JSON.stringify(actual.origin?.user)}, expected role ${expected.origin.user}`);
  }
  exact(actual.mtls?.sslmode, expected.mtls.sslmode, "mtls.sslmode");
  exact(
    actual.origin_connection_limit,
    expected.origin_connection_limit,
    "origin_connection_limit",
  );
  exact(actual.caching?.disabled, expected.caching.disabled, "caching.disabled");
  if (!/^[0-9a-f]{32}$/u.test(actual.id ?? "")) {
    throw new Error(`${expected.name} returned an invalid id`);
  }
  return {
    id: actual.id,
    name: actual.name,
    origin: {
      scheme: actual.origin.scheme,
      host: actual.origin.host,
      port: actual.origin.port,
      database: actual.origin.database,
      user: actual.origin.user,
    },
    caching: actual.caching,
    mtls: actual.mtls,
    originConnectionLimit: actual.origin_connection_limit,
  };
}

export async function reconcileProductionHyperdrives({
  source = process.env,
  fetchImpl = globalThis.fetch,
  expectedOrigin = productionPostgresOrigin(source),
  requiredIds,
} = {}) {
  const desired = desiredProductionHyperdrives(source, expectedOrigin);
  const prefix = `/accounts/${desired.accountId}/hyperdrive/configs`;
  const listed = await cloudflare(fetchImpl, desired.apiToken, `${prefix}?per_page=50`);
  if (!Array.isArray(listed)) throw new Error("Cloudflare Hyperdrive list is invalid");
  const evidence = [];
  for (const config of desired.configs) {
    const matches = listed.filter((candidate) => candidate.name === config.name);
    if (matches.length > 1) throw new Error(`duplicate Hyperdrive name: ${config.name}`);
    let id = matches[0]?.id;
    if (requiredIds) {
      const requiredId = requiredIds[config.name];
      if (!/^[0-9a-f]{32}$/u.test(requiredId ?? "") || id !== requiredId) {
        throw new Error(`${config.name} does not match its reviewed migration id`);
      }
    }
    if (id) {
      await cloudflare(fetchImpl, desired.apiToken, `${prefix}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(config),
      });
    } else {
      const created = await cloudflare(fetchImpl, desired.apiToken, prefix, {
        method: "POST",
        body: JSON.stringify(config),
      });
      id = created?.id;
    }
    if (!/^[0-9a-f]{32}$/u.test(id ?? "")) {
      throw new Error(`${config.name} did not return a valid id`);
    }
    const readback = await cloudflare(fetchImpl, desired.apiToken, `${prefix}/${id}`);
    evidence.push(verifyProductionHyperdrive(readback, config));
  }
  return { schemaVersion: 1, configs: evidence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await reconcileProductionHyperdrives();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
