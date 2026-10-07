#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { resolveTestPostgresTools } from "./test-postgres-tools.mjs";
import { turboCacheArgs } from "./turbo-cache.mjs";

// A fresh private Unix socket, not an inherited DATABASE_URL or running daemon.
if (process.platform === "win32") throw new Error("This local reproduction runner requires POSIX PostgreSQL tools.");
const postgresTools = resolveTestPostgresTools();
const root = fileURLToPath(new URL("../", import.meta.url));
// Hub tests import TypeScript sources statically: every Hub test process needs
// the same loader and platform preload that packages/hub/test/run-suite.mjs gives its lanes.
const hubTestImports = ["--import", "tsx", "--import", "./test/support/platform-preload.mjs"];
const directory = mkdtempSync("/tmp/xmatrix-routing-repro-");
const data = join(directory, "pg");
const lifecycle = process.argv.includes("--lifecycle-connect-retry");
const lifecycleTerminal = process.argv.includes("--lifecycle-terminal");
const lifecycleFailure = process.argv.includes("--lifecycle-start-failure");
const lifecycleScheduled = process.argv.includes("--lifecycle-scheduled");
const lifecycleWorkspace = process.argv.includes("--lifecycle-workspace");
const hubSuite = process.argv.includes("--hub-suite");
const hubIntegrations = process.argv.includes("--hub-postgres-integrations");
// Hosted CI spreads the Hub suite over parallel jobs: one runs the workspace
// packages' PostgreSQL tests ("packages"), the others each run one
// XMATRIX_HUB_TEST_SHARD of the Hub test files ("files"). Together they are
// the complete suite; the default runs both in one process.
const hubSuitePart = process.env.XMATRIX_HUB_SUITE_PART || "all";
if (!["all", "packages", "files"].includes(hubSuitePart)) {
  throw new Error("XMATRIX_HUB_SUITE_PART must be all, packages or files");
}
const hubSuitePackages = hubSuite && hubSuitePart !== "files";
const hubSuiteFiles = hubSuite && hubSuitePart !== "packages";
if ([lifecycle, lifecycleTerminal, lifecycleFailure, lifecycleScheduled, lifecycleWorkspace, hubSuite, hubIntegrations].filter(Boolean).length > 1) throw new Error("Choose a single reproduction mode.");
const needsTcp = lifecycle || lifecycleTerminal || lifecycleFailure || lifecycleScheduled || lifecycleWorkspace || hubSuite || hubIntegrations;
const port = needsTcp ? await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = String(server.address().port);
    server.close(() => resolve(value));
  });
}) : "55439";
const role = "routing_repro";
const url = new URL(`postgresql://${role}@localhost/routing_repro`);
url.searchParams.set("host", directory);
url.searchParams.set("port", port);
function run(command, args, extraEnv = {}, timeout = 180000) {
  const result = spawnSync(postgresTools[command] ?? command, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: "inherit", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}
const workerTemplate = "routing_repro_worker_template";
const hubPostgresEnv = {
  XMATRIX_TEST_POSTGRES_URL: `postgresql://${role}@127.0.0.1:${port}/routing_repro`,
  XMATRIX_TEST_POSTGRES_TEMPLATE: workerTemplate,
};
let started = false;
try {
  run("initdb", ["-D", data, "-U", role, "-A", "trust", "--no-locale", "-E", "UTF8"]);
  run("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o", `-k ${directory} -p ${port} -h '${needsTcp ? "127.0.0.1" : ""}'`, "-w", "start"]);
  started = true;
  run("createdb", ["-h", directory, "-p", port, "-U", role, "routing_repro"]);
  run("psql", ["-h", directory, "-p", port, "-U", role, "-d", "routing_repro", "-v", "ON_ERROR_STOP=1",
    "-c", "CREATE ROLE routing_repro_runtime NOLOGIN"]);
  // A throwaway test database: it takes contract migrations too.
  run("node", ["packages/db/scripts/migrate.mjs", "apply", "--allow-contract"], {
    DATABASE_URL: url.toString(), POSTGRES_RUNTIME_ROLE: "routing_repro_runtime",
  });
  if (needsTcp) run("psql", ["-h", directory, "-p", port, "-U", role, "-d", "routing_repro",
    "-v", "ON_ERROR_STOP=1", "-c", "INSERT INTO control.postgres_shards " +
    "(shard_id,state,capacity_class,created_at,updated_at) VALUES ('shard-0','active','local-repro',now(),now())"]);
  // Each PostgreSQL Hub test worker clones a private database from this copy
  // (agent-launch-postgres.fixture.mjs). The shared database cannot be the
  // template: CREATE DATABASE refuses a source other sessions are using.
  if (needsTcp) run("createdb", ["-h", directory, "-p", port, "-U", role, "-T", "routing_repro", workerTemplate]);
  // Through Turbo's shared cache: CI has already built these for the same
  // content, so this restores them instead of compiling them a second time.
  run("pnpm", ["exec", "turbo", "run", "build", "--filter=@xmatrix/protocol", "--filter=@xmatrix/db",
    "--output-logs=new-only", ...turboCacheArgs()]);
  if (!needsTcp) run("node", ["--test", "packages/db/test/agent-launch-postgres.test.mjs"], {
    XMATRIX_REQUIRE_POSTGRES_TEST: "true", XMATRIX_TEST_POSTGRES_URL: url.toString(),
  });
  if (lifecycle) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/agent-instance-connect-retry.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  if (lifecycleTerminal) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/agent-terminal-cleanup.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  if (lifecycleFailure) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/agent-start-failure-notice.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  if (lifecycleScheduled) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/automation-api.e2e.mjs", "test/automation-delivery.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  if (lifecycleWorkspace) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/agent-mention-workspace-spawn.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  // The move to pages races two first drafts on real connections; only a real database proves it.
  // Staged registration launches are rechecked while other launch work runs in
  // their Channel; only a real database interleaves the recheck with a commit.
  if (hubSuitePackages) run("node", ["--test", "packages/db/test/page-migration-postgres.test.mjs",
    "packages/db/test/client-postgres.test.mjs",
    "packages/db/test/page-control-postgres.test.mjs",
    "packages/db/test/agent-registration-launch-postgres.test.mjs", "packages/db/test/agent-lifecycle-cleanup.test.mjs",
    "packages/db/test/legacy-hostname-retirement-postgres.test.mjs",
    "packages/db/test/agent-registration-control-postgres.test.mjs",
    "packages/db/test/secret-request-postgres.test.mjs",
    // A Run's secret read must not wait on a launch holding its Channel row.
    "packages/db/test/space-secret-postgres.test.mjs",
    "packages/db/test/app-credential-postgres.test.mjs",
    "packages/db/test/discord-lifecycle-postgres.test.mjs",
    "packages/db/test/sentry-event-postgres.test.mjs",
    "packages/db/test/github-write-policy-migration-postgres.test.mjs",
    "packages/db/test/message-history-tombstone-senders-postgres.test.mjs",
    // A history page is one fenced statement, and a placed single read must
    // serialize with a Space move on the placement row lock.
    "packages/db/test/message-history-postgres.test.mjs",
    "packages/db/test/placement-fence-postgres.test.mjs"], {
    XMATRIX_REQUIRE_POSTGRES_TEST: "true", XMATRIX_TEST_POSTGRES_URL: url.toString(),
  });
  // Catalog/metadata fixtures reset their Space closure: run after the other
  // PostgreSQL files, never concurrently with their live authorities.
  if (hubSuitePackages) run("node", ["--test", "packages/db/test/channel-catalog-postgres.test.mjs"], {
    XMATRIX_REQUIRE_POSTGRES_TEST: "true", XMATRIX_TEST_POSTGRES_URL: url.toString(),
  });
  // Workspace packages whose SQL only a real database proves declare test:postgres.
  if (hubSuitePackages) run("pnpm", ["--recursive", "--if-present", "run", "test:postgres"], {
    XMATRIX_REQUIRE_POSTGRES_TEST: "true", XMATRIX_TEST_POSTGRES_URL: url.toString(),
  });
  if (hubSuiteFiles) run("pnpm", ["--dir", "packages/hub", "exec", "node", "test/run-suite.mjs",
    "--test-concurrency=auto", "--test-timeout=300000"], {
    ...hubPostgresEnv,
  }, 30 * 60 * 1000);
  if (hubIntegrations) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test",
    "test/scheduled-timeout-postgres.integration.test.mjs"], {
    ...hubPostgresEnv,
    XMATRIX_REQUIRE_POSTGRES_TEST: "true",
  });
} finally {
  if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  console.log(`Reproduction database and PostgreSQL log retained at ${directory}; no production data was used.`);
}
