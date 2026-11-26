import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runIfInvoked } from "./cli.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testDirectory = join(packageRoot, "test");

// These fixtures wipe shared tables on the shared integration database, so they
// must run one file at a time after the parallel PostgreSQL files.
const SERIAL_POSTGRES_TESTS = Object.freeze([
  "channel-catalog-postgres.test.mjs",
  "agent-launch-postgres.test.mjs",
  "agent-registration-quota-probe-postgres.test.mjs",
  "registration-quota-scopes-postgres.test.mjs",
  "registration-quota-waiters-postgres.test.mjs",
]);

// Owned by `packages/db`'s `test:postgres` two-cluster runner (scripts/test-dingtalk-crossdb.mjs).
const EXTERNAL_POSTGRES_TESTS = Object.freeze([
  "dingtalk-crossdb-postgres.test.mjs",
]);

// Pre-existing PostgreSQL integration files that were never registered in the
// former hardcoded list and drifted against later migrations before auto-discovery
// was enabled. New PostgreSQL tests are discovered automatically and must not be
// added here; remove entries as their owning areas repair them.
export const QUARANTINED_POSTGRES_TESTS = Object.freeze([
  "activation-report-postgres.test.mjs",
  "agent-registration-environment-postgres.test.mjs",
  "dingtalk-effects-postgres.test.mjs",
  "direct-conversation-purge-postgres.test.mjs",
  "harness-named-models-migration-postgres.test.mjs",
  "message-instance-attention-postgres.test.mjs",
  "message-invocation-selections-postgres.test.mjs",
  "message-preflight-lock-postgres.test.mjs",
  "natural-key-reservations-postgres.test.mjs",
  "trace-access-postgres.test.mjs",
]);

// The package check has no database, so integration() is test.skip. Node still
// starts a process and loads the client for every matched file. Files with no
// direct test() call are that gate only; the Hub suite runs them for real.
export function declaresUngatedTest(source) {
  return /\btest(?:\.(?:skip|only))?\s*\(/u.test(source);
}

export function declaresPostgresTest(source) {
  return /\bintegration\s*\(/u.test(source)
    || /\bXMATRIX_(?:TEST_POSTGRES_URL|REQUIRE_POSTGRES_TEST)\b/u.test(source);
}

export function postgresConfigured(env = process.env) {
  return Boolean(env.XMATRIX_TEST_POSTGRES_URL?.trim() || env.XMATRIX_REQUIRE_POSTGRES_TEST === "true");
}

export function packageTestFiles(env = process.env) {
  return readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .filter((name) => postgresConfigured(env) || declaresUngatedTest(readFileSync(join(testDirectory, name), "utf8")))
    .map((name) => join("test", name));
}

export function postgresSuitePlan() {
  const discovered = readdirSync(testDirectory)
    .filter((name) => name.endsWith(".test.mjs") && name !== "package-tests.test.mjs")
    .sort()
    .filter((name) => declaresPostgresTest(readFileSync(join(testDirectory, name), "utf8")));
  const discoveredSet = new Set(discovered);
  const serialSet = new Set(SERIAL_POSTGRES_TESTS);
  const externalSet = new Set(EXTERNAL_POSTGRES_TESTS);
  const quarantinedSet = new Set(QUARANTINED_POSTGRES_TESTS);
  for (const [label, list] of [
    ["serial", SERIAL_POSTGRES_TESTS],
    ["external", EXTERNAL_POSTGRES_TESTS],
    ["quarantined", QUARANTINED_POSTGRES_TESTS],
  ]) {
    for (const name of list) {
      if (!discoveredSet.has(name)) {
        throw new Error(`Listed ${label} PostgreSQL test is not a discovered PostgreSQL test: ${name}`);
      }
    }
  }
  const parallel = discovered
    .filter((name) => !serialSet.has(name) && !externalSet.has(name) && !quarantinedSet.has(name))
    .map((name) => join("packages", "db", "test", name));
  const serial = SERIAL_POSTGRES_TESTS.map((name) => join("packages", "db", "test", name));
  return Object.freeze({
    parallel: Object.freeze(parallel),
    serial: Object.freeze(serial),
    external: EXTERNAL_POSTGRES_TESTS,
    quarantined: QUARANTINED_POSTGRES_TESTS,
  });
}

function commandChunks(files) {
  const chunks = [];
  let current = [];
  let length = "node --test ".length;
  for (const file of files) {
    if (current.length > 0 && length + file.length + 1 > 6000) {
      chunks.push(current);
      current = [];
      length = "node --test ".length;
    }
    current.push(file);
    length += file.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function main() {
  const files = packageTestFiles();
  if (files.length === 0) throw new Error("No package tests selected");
  for (const chunk of commandChunks(files)) {
    const child = spawnSync(process.execPath, ["--test", ...chunk], {
      cwd: packageRoot,
      stdio: "inherit",
      env: process.env,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
}

runIfInvoked(import.meta.url, main);
