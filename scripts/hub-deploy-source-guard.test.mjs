import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { verifyHubDeploySource } from "./hub-deploy-source-guard.mjs";

const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function commit(root, message) {
  git(root, "add", ".");
  git(root, "commit", "--quiet", "--message", message);
  return git(root, "rev-parse", "HEAD");
}

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "xmatrix-hub-source-guard-"));
  temporaryRoots.add(base);
  const root = path.join(base, "repository");
  const source = path.join(root, "packages", "hub", "src");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "index.ts"), "export const healthy = true;\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Hub source guard test");
  git(root, "config", "user.email", "hub-source-guard@invalid.example");
  const sha = commit(root, "clean fixture");
  return { root, source, sha };
}

test("a clean exact-SHA checkout passes", async () => {
  const current = fixture();
  await assert.doesNotReject(verifyHubDeploySource({
    repoRoot: current.root,
    expectedSha: current.sha,
  }));
});

test("source verification rejects an expected-SHA mismatch and a dirty worktree", async () => {
  const mismatched = fixture();
  await assert.rejects(
    verifyHubDeploySource({
      repoRoot: mismatched.root,
      expectedSha: "f".repeat(40),
    }),
    /does not match expected SHA/u,
  );

  const dirty = fixture();
  appendFileSync(path.join(dirty.source, "index.ts"), "export const changed = true;\n");
  await assert.rejects(
    verifyHubDeploySource({
      repoRoot: dirty.root,
      expectedSha: dirty.sha,
    }),
    /worktree is not clean/u,
  );
});

test("source verification rejects ignored files that are not bound to the SHA", async () => {
  const current = fixture();
  writeFileSync(path.join(current.root, ".gitignore"), "packages/hub/src/ignored.ts\n");
  const sha = commit(current.root, "ignore fixture source");
  writeFileSync(path.join(current.source, "ignored.ts"), "export const ignored = true;\n");
  await assert.rejects(
    verifyHubDeploySource({
      repoRoot: current.root,
      expectedSha: sha,
    }),
    /non-checked-in ignored file/u,
  );
});
