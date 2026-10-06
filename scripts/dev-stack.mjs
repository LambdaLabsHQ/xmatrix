#!/usr/bin/env node
/**
 * One command for a complete local xMatrix: PostgreSQL, the Hub Worker and the
 * Web app, signed in as a local developer.
 *
 *   pnpm dev:stack            # start (state persists in .xmatrix-dev/)
 *   pnpm dev:stack --reset    # wipe local state first
 *
 * PostgreSQL is the bundled embedded-postgres 17 unless XMATRIX_DEV_DATABASE_URL
 * points at a database you own. The Hub runs in workerd through Wrangler with
 * every PostgreSQL authority enabled; sign-in uses the Hub's local mock token,
 * so no mail, OAuth or Cloudflare account is needed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// pg is a dependency of the db package, not of the workspace root.
const pg = createRequire(join(root, "packages/db/package.json"))("pg");
const hubDir = join(root, "packages/hub");
const stateDir = join(root, ".xmatrix-dev");
const pgDataDir = join(stateDir, "postgres");
const hubStateDir = join(stateDir, "hub");

const PG_PORT = Number(process.env.XMATRIX_DEV_PG_PORT || 54329);
const HUB_PORT = Number(process.env.XMATRIX_DEV_HUB_PORT || 8787);
const WEB_PORT = Number(process.env.XMATRIX_DEV_WEB_PORT || 3001);
const DATABASE = "xmatrix";
const RUNTIME_ROLE = "xmatrix_runtime";
const SHARD_ID = "shard-0";

// Local-only credentials. They sign local sessions and never leave this machine.
const DEV_TOKEN = "xmatrix-local-dev-token";
const DEV_USER = { id: "local-dev", email: "dev@xmatrix.localhost", name: "Local Developer" };

/**
 * Production's product vars (every PostgreSQL authority, fact materialization,
 * feature switches) read from the committed production Hub config, so the
 * local Hub behaves like production and follows it as switches are removed.
 * Its [vars] values are plain strings.
 */
function productionProductVars() {
  const source = readFileSync(join(hubDir, "wrangler.toml"), "utf8");
  const vars = {};
  let inVars = false;
  for (const line of source.split("\n")) {
    if (/^\s*\[/u.test(line)) inVars = /^\s*\[vars\]\s*$/u.test(line);
    const match = inVars && line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/u);
    if (match) vars[match[1]] = match[2];
  }
  if (vars.AUTH_AUTHORITY !== "postgres") throw new Error("could not read the production Hub [vars]");
  return vars;
}

function log(message) {
  process.stderr.write(`[dev-stack] ${message}\n`);
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}`);
}

async function startPostgres() {
  const external = process.env.XMATRIX_DEV_DATABASE_URL?.trim();
  if (external) {
    log("using XMATRIX_DEV_DATABASE_URL");
    return { url: external, stop: async () => {} };
  }
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const fresh = !existsSync(join(pgDataDir, "PG_VERSION"));
  const postgres = new EmbeddedPostgres({
    databaseDir: pgDataDir,
    user: "postgres",
    password: "postgres",
    port: PG_PORT,
    persistent: true,
    onLog: () => {},
  });
  if (fresh) {
    log(`initializing PostgreSQL in ${pgDataDir}`);
    await postgres.initialise();
  }
  await postgres.start();
  if (fresh) await postgres.createDatabase(DATABASE);
  const url = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${DATABASE}`;
  return { url, stop: () => postgres.stop() };
}

async function prepareDatabase(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
        CREATE ROLE ${RUNTIME_ROLE} NOLOGIN;
      END IF;
    END $$`);
  } finally {
    await client.end();
  }
  log("applying PostgreSQL migrations");
  run("node", ["packages/db/scripts/migrate.mjs", "apply", "--allow-contract"], {
    DATABASE_URL: url,
    POSTGRES_RUNTIME_ROLE: RUNTIME_ROLE,
  });
  const admission = new pg.Client({ connectionString: url });
  await admission.connect();
  try {
    await admission.query(
      `INSERT INTO control.postgres_shards (shard_id, state, capacity_class, created_at, updated_at)
       VALUES ($1, 'active', 'local-dev', now(), now()) ON CONFLICT (shard_id) DO NOTHING`,
      [SHARD_ID],
    );
  } finally {
    await admission.end();
  }
}

function hubConfigPath() {
  // The local Hub config plus, without a Jev key, a deterministic local
  // routing model that always picks the first candidate.
  const path = join(stateDir, "wrangler.dev.toml");
  let config = readFileSync(join(hubDir, "wrangler.test.toml"), "utf8");
  if (!process.env.JEV_AI_GATEWAY_API_KEY) {
    const decisionModel = join(hubDir, "test/fixtures/local-routing-decision.mjs");
    config += `\n[alias]\n"@xmatrix/decision-model" = ${JSON.stringify(decisionModel)}\n`;
  }
  writeFileSync(path, config);
  return path;
}

async function startHub(databaseUrl) {
  const { unstable_dev } = await import("wrangler");
  log(`starting Hub on http://127.0.0.1:${HUB_PORT}`);
  // The production entrypoint, as a fresh self-hosted deployment runs it.
  return unstable_dev(join(hubDir, "src/index.ts"), {
    config: hubConfigPath(),
    local: true,
    port: HUB_PORT,
    ip: "127.0.0.1",
    logLevel: "warn",
    persist: true,
    persistTo: hubStateDir,
    vars: {
      ...productionProductVars(),
      RELAY_POSTGRES: { connectionString: databaseUrl },
      RELAY_POSTGRES_SHARD_ID: SHARD_ID,
      APP_URL: `http://localhost:${WEB_PORT}`,
      HUB_URL: `http://localhost:${HUB_PORT}`,
      BETTER_AUTH_SECRET: "xmatrix-local-dev-better-auth-secret",
      XMATRIX_SECRET_CATALOG_KEY: "xmatrix-local-dev-secret-catalog-key",
      XMATRIX_MOCK_AUTH_TOKEN: DEV_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: DEV_USER.id,
      XMATRIX_MOCK_AUTH_EMAIL: DEV_USER.email,
      XMATRIX_MOCK_AUTH_NAME: DEV_USER.name,
      ...(process.env.JEV_AI_GATEWAY_API_KEY ? {} : { JEV_AI_GATEWAY_API_KEY: "local-dev-not-a-provider-credential" }),
    },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  });
}

function startWeb() {
  const hub = `http://localhost:${HUB_PORT}`;
  log(`starting Web on http://localhost:${WEB_PORT}`);
  return spawn("pnpm", ["--filter", "@xmatrix/web", "exec", "next", "dev", "--turbopack", "-p", String(WEB_PORT)], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: `http://localhost:${WEB_PORT}`,
      NEXT_PUBLIC_AUTH_BASE_URL: hub,
      NEXT_PUBLIC_XMATRIX_HUB_URL: hub,
      NEXT_PUBLIC_XMATRIX_MOCK_AUTH_TOKEN: DEV_TOKEN,
      NEXT_PUBLIC_XMATRIX_MOCK_AUTH_USER_ID: DEV_USER.id,
      NEXT_PUBLIC_XMATRIX_MOCK_AUTH_EMAIL: DEV_USER.email,
      NEXT_PUBLIC_XMATRIX_MOCK_AUTH_NAME: DEV_USER.name,
    },
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const hubOnly = args.has("--hub-only");
  if (args.has("--reset")) {
    log(`removing ${stateDir}`);
    rmSync(stateDir, { recursive: true, force: true });
  }
  mkdirSync(stateDir, { recursive: true });

  log("building workspace packages the Hub imports");
  run("pnpm", ["exec", "turbo", "run", "build", "--filter=@xmatrix/hub^...", "--output-logs=errors-only"]);

  const postgres = await startPostgres();
  const stops = [() => postgres.stop()];
  const stop = async () => {
    for (const fn of stops.reverse()) await fn().catch(() => {});
  };
  process.once("SIGINT", () => stop().then(() => process.exit(130)));
  process.once("SIGTERM", () => stop().then(() => process.exit(143)));
  try {
    await prepareDatabase(postgres.url);
    const hub = await startHub(postgres.url);
    stops.push(() => hub.stop());
    let web;
    if (!hubOnly) {
      web = startWeb();
      stops.push(async () => { web.kill("SIGTERM"); });
    }
    process.stdout.write([
      "",
      "xMatrix is running locally.",
      hubOnly ? "" : `  Web   http://localhost:${WEB_PORT}/app   (signed in as ${DEV_USER.name})`,
      `  Hub   http://localhost:${HUB_PORT}`,
      `  DB    ${postgres.url}`,
      `  CLI   XMATRIX_HUB_URL=http://localhost:${HUB_PORT} XMATRIX_TOKEN=${DEV_TOKEN} xmatrix channels`,
      "Press Ctrl-C to stop. State is kept in .xmatrix-dev/ (use --reset to start over).",
      "",
    ].filter((line) => line !== "").join("\n") + "\n");
    if (web) {
      await new Promise((resolveExit) => web.once("exit", resolveExit));
      await stop();
    } else {
      await new Promise(() => {});
    }
  } catch (error) {
    await stop();
    throw error;
  }
}

await main();
