#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { resolveTestPostgresTools } from "./test-postgres-tools.mjs";
import { turboCacheArgs } from "./turbo-cache.mjs";
import { postgresSuitePlan } from "../packages/db/scripts/package-tests.mjs";

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
const lifecycleWorkspace = process.argv.includes("--lifecycle-workspace");
const hubSuite = process.argv.includes("--hub-suite");
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
if ([lifecycle, lifecycleTerminal, lifecycleFailure, lifecycleWorkspace, hubSuite].filter(Boolean).length > 1) throw new Error("Choose a single reproduction mode.");
const needsTcp = lifecycle || lifecycleTerminal || lifecycleFailure || lifecycleWorkspace || hubSuite;
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
const runtimeRole = `${role}_runtime`;
const cleanTemplate = "routing_repro_clean_template";
const workerTemplate = "routing_repro_worker_template";
const needsWorkerTemplate = lifecycle || lifecycleTerminal || lifecycleFailure || lifecycleWorkspace || hubSuiteFiles;
const needsCleanTemplate = hubSuitePackages || hubSuiteFiles;
const packagePostgresEnv = {
  XMATRIX_REQUIRE_POSTGRES_TEST: "true",
  XMATRIX_TEST_POSTGRES_URL: url.toString(),
  ...(needsCleanTemplate ? {
    XMATRIX_TEST_POSTGRES_CLEAN_TEMPLATE: cleanTemplate,
    XMATRIX_TEST_POSTGRES_TEMPLATE_ROLE: runtimeRole,
  } : {}),
};
const hubPostgresEnv = {
  XMATRIX_TEST_POSTGRES_URL: `postgresql://${role}@127.0.0.1:${port}/routing_repro`,
  XMATRIX_TEST_POSTGRES_TEMPLATE: workerTemplate,
  ...(needsCleanTemplate ? {
    XMATRIX_TEST_POSTGRES_CLEAN_TEMPLATE: cleanTemplate,
    XMATRIX_TEST_POSTGRES_TEMPLATE_ROLE: runtimeRole,
  } : {}),
};
let started = false;
try {
  // Throwaway test cluster: skip crash-recovery fsyncs (non-durable mode) while
  // keeping identical PostgreSQL SQL, MVCC, lock, index and constraint semantics.
  run("initdb", ["-D", data, "-U", role, "-A", "trust", "--no-locale", "-E", "UTF8", "--no-sync"]);
  run("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"),
    "-o", `-k ${directory} -p ${port} -h '${needsTcp ? "127.0.0.1" : ""}' -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
    "-w", "start"]);
  started = true;
  run("createdb", ["-h", directory, "-p", port, "-U", role, "routing_repro"]);
  run("psql", ["-h", directory, "-p", port, "-U", role, "-d", "routing_repro", "-v", "ON_ERROR_STOP=1",
    "-c", `CREATE ROLE ${runtimeRole} NOLOGIN`]);
  // A throwaway test database: it takes contract migrations too.
  run("node", ["packages/db/scripts/migrate.mjs", "apply", "--allow-contract"], {
    DATABASE_URL: url.toString(), POSTGRES_RUNTIME_ROLE: runtimeRole,
  });
  // Snapshot the cleanly migrated schema before seeding shard-0 so isolatedPostgres()
  // fixtures clone in milliseconds instead of re-applying every migration per test.
  if (needsCleanTemplate) run("createdb", ["-h", directory, "-p", port, "-U", role, "-T", "routing_repro", cleanTemplate]);
  if (needsTcp) run("psql", ["-h", directory, "-p", port, "-U", role, "-d", "routing_repro",
    "-v", "ON_ERROR_STOP=1", "-c", "INSERT INTO control.postgres_shards " +
    "(shard_id,state,capacity_class,created_at,updated_at) VALUES ('shard-0','active','local-repro',now(),now())"]);
  // Each PostgreSQL Hub test worker clones a private database from this copy
  // (agent-launch-postgres.fixture.mjs). The shared database cannot be the
  // template: CREATE DATABASE refuses a source other sessions are using.
  if (needsWorkerTemplate) run("createdb", ["-h", directory, "-p", port, "-U", role, "-T", "routing_repro", workerTemplate]);
  // Through Turbo's shared cache: CI has already built these for the same
  // content, so this restores them instead of compiling them a second time.
  run("pnpm", ["exec", "turbo", "run", "build", "--filter=@xmatrix/protocol", "--filter=@xmatrix/db",
    "--filter=@xmatrix/billing-official",
    "--output-logs=new-only", ...turboCacheArgs()]);
  if (!needsTcp) run("node", ["--test", "packages/db/test/agent-launch-postgres.test.mjs"], {
    XMATRIX_REQUIRE_POSTGRES_TEST: "true", XMATRIX_TEST_POSTGRES_URL: url.toString(),
  });
  if (lifecycle) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/agent-instance-connect-retry.e2e.mjs", "test/agent-turn-retry.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  if (lifecycleTerminal) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/agent-terminal-cleanup.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  if (lifecycleFailure) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/agent-start-failure-notice.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  if (lifecycleWorkspace) run("pnpm", ["--dir", "packages/hub", "exec", "node", ...hubTestImports, "--test", "test/agent-mention-workspace-spawn.e2e.mjs"], {
    ...hubPostgresEnv,
  });
  // Auto-discover every PostgreSQL integration test in packages/db/test so new
  // tests can never be silently skipped by both node-tests and the Hub suite.
  if (hubSuitePackages) {
    const dbSuite = postgresSuitePlan();
    run("node", ["--test", ...dbSuite.parallel], packagePostgresEnv);
    for (const serialFile of dbSuite.serial) {
      run("node", ["--test", serialFile], packagePostgresEnv);
    }
  }
  // Workspace packages whose SQL only a real database proves declare test:postgres
  // (e.g. packages/billing-official and packages/db's two-cluster DingTalk suite).
  if (hubSuitePackages) run("pnpm", ["--recursive", "--if-present", "run", "test:postgres"], packagePostgresEnv);
  if (hubSuiteFiles) run("pnpm", ["--dir", "packages/hub", "exec", "node", "test/run-suite.mjs",
    "--test-concurrency=auto", "--test-timeout=300000"], {
    ...hubPostgresEnv,
  }, 30 * 60 * 1000);
} finally {
  if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  console.log(`Reproduction database and PostgreSQL log retained at ${directory}; no production data was used.`);
}
