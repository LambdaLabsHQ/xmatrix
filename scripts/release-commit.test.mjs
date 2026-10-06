import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { releaseCommitProblem, verifyReleaseCommit } from "./release-commit.mjs";
import { isReleaseCommitOfMain } from "./production-release-policy.mjs";
import { stampVersionText, versionedPaths } from "./version.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const a = "a".repeat(40);
const b = "b".repeat(40);

test("a release commit is one child of its source differing only by version", () => {
  assert.equal(releaseCommitProblem({ deploySha: a, sourceSha: a, parents: [] }), null);
  assert.equal(releaseCommitProblem({ deploySha: a, sourceSha: b, parents: [b], deployKey: "k", sourceKey: "k" }), null);
  assert.match(releaseCommitProblem({ deploySha: a, sourceSha: b, parents: [b], deployKey: "k", sourceKey: "j" }), /changes more than the release version/u);
  assert.match(releaseCommitProblem({ deploySha: a, sourceSha: b, parents: ["c".repeat(40)], deployKey: "k", sourceKey: "k" }), /not a release commit/u);
  assert.match(releaseCommitProblem({ deploySha: a, sourceSha: b, parents: [b, "c".repeat(40)], deployKey: "k", sourceKey: "k" }), /not a release commit/u);
  assert.match(releaseCommitProblem({ deploySha: "short", sourceSha: b, parents: [b] }), /full commit SHAs/u);
});

function fixtureRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "xmatrix-release-commit-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  for (const file of versionedPaths) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), readFileSync(path.join(repoRoot, file), "utf8"));
  }
  writeFileSync(path.join(root, "source.txt"), "source\n");
  git("add", "--all");
  git("commit", "--quiet", "--message", "source");
  const commit = (message, edit) => {
    edit();
    git("commit", "--quiet", "--all", "--message", message);
    return git("rev-parse", "HEAD");
  };
  const stamp = (next) => () => {
    for (const file of versionedPaths) {
      const target = path.join(root, file);
      writeFileSync(target, stampVersionText(file, readFileSync(target, "utf8"), next));
    }
  };
  return { root, git, commit, stamp, source: git("rev-parse", "HEAD") };
}

test("verification accepts the stamped release commit and nothing more", () => {
  const repo = fixtureRepository();
  try {
    const release = repo.commit("Release 99.0.0", repo.stamp("99.0.0"));
    verifyReleaseCommit(repo.root, release, repo.source);
    verifyReleaseCommit(repo.root, repo.source, repo.source);

    // Anything besides the version, even alongside it, is not a release commit.
    const smuggled = repo.commit("Release 99.0.1", () => {
      repo.stamp("99.0.1")();
      writeFileSync(path.join(repo.root, "source.txt"), "changed\n");
    });
    assert.throws(() => verifyReleaseCommit(repo.root, smuggled, release), /changes more than the release version/u);
    // A grandchild is not a release commit of the source.
    assert.throws(() => verifyReleaseCommit(repo.root, smuggled, repo.source), /not a release commit/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("main history admits a release commit whose parent is on main", () => {
  const repo = fixtureRepository();
  try {
    repo.git("update-ref", "refs/remotes/origin/main", repo.source);
    repo.git("checkout", "--quiet", "--detach");
    const release = repo.commit("Release 99.0.0", repo.stamp("99.0.0"));
    assert.equal(isReleaseCommitOfMain(repo.root, release), true);
    const other = repo.commit("unrelated", () => writeFileSync(path.join(repo.root, "source.txt"), "x\n"));
    assert.equal(isReleaseCommitOfMain(repo.root, other), false);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
