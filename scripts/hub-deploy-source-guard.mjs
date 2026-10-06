#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runCliMain } from "./cli-entrypoint.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`[hub-deploy-source-guard] ${message}`);
}

function fullCommitSha(value, label = "expected SHA") {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/iu.test(value)) {
    fail(`${label} must be a full 40-character Git commit SHA`);
  }
  return value.toLowerCase();
}

async function git(repoRoot, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const detail = typeof error?.stderr === "string" && error.stderr.trim().length > 0
      ? `: ${error.stderr.trim()}`
      : "";
    fail(`git ${args[0]} failed${detail}`);
  }
}

export async function assertExactCleanCheckout(repoRoot, expectedSha) {
  const root = await realpath(path.resolve(repoRoot));
  const expected = fullCommitSha(expectedSha);
  const resolvedRoot = await realpath(
    path.resolve((await git(root, ["rev-parse", "--show-toplevel"])).trim()),
  );
  if (resolvedRoot !== root) {
    fail(`repository root mismatch: expected ${root}, found ${resolvedRoot}`);
  }

  const actual = fullCommitSha(
    (await git(root, ["rev-parse", "HEAD"])).trim(),
    "checked-out HEAD",
  );
  if (actual !== expected) {
    fail(`checked-out HEAD ${actual} does not match expected SHA ${expected}`);
  }

  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) {
    const firstEntry = status.split(/\r?\n/u).find((line) => line.length > 0) ?? "unknown change";
    fail(`worktree is not clean: ${firstEntry}`);
  }
  const ignoredHubSource = await git(root, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    "packages/hub/src",
  ]);
  if (ignoredHubSource.length > 0) {
    const firstEntry = ignoredHubSource.split(/\r?\n/u).find((line) => line.length > 0) ??
      "unknown ignored source";
    fail(`Hub source contains a non-checked-in ignored file: ${firstEntry}`);
  }
  return actual;
}

export async function verifyHubDeploySource({ repoRoot = REPOSITORY_ROOT, expectedSha }) {
  return { sha: await assertExactCleanCheckout(repoRoot, expectedSha) };
}

function parseCli(argv) {
  const [mode, flag, expectedSha, ...rest] = argv;
  if (mode !== "source" || flag !== "--expected-sha" || expectedSha === undefined || rest.length > 0) {
    fail("usage: hub-deploy-source-guard.mjs source --expected-sha <sha>");
  }
  return { expectedSha: fullCommitSha(expectedSha) };
}

export async function main(argv = process.argv.slice(2)) {
  const { expectedSha } = parseCli(argv);
  const result = await verifyHubDeploySource({ expectedSha });
  console.log(`[hub-deploy-source-guard] verified source at ${result.sha}`);
}

runCliMain(import.meta.url, main);
