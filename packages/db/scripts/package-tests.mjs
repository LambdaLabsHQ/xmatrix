import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runIfInvoked } from "./cli.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testDirectory = join(packageRoot, "test");

// The package check has no database, so integration() is test.skip. Node still
// starts a process and loads the client for every matched file. Files with no
// direct test() call are that gate only; the Hub suite runs them for real.
export function declaresUngatedTest(source) {
  return /\btest(?:\.(?:skip|only))?\s*\(/u.test(source);
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
