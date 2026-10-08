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

test("a release commit is one child of its source differing only by the version stamp", () => {
  const lock = (own) => `[[package]]\nname = "anstream"\nversion = "1.0.0"\n\n[[package]]\nname = "xmatrix"\nversion = "${own}"\n`;
  const change = (file, source, deploy, modes = ["100644", "100644"]) =>
    ({ file, source, deploy, sourceMode: modes[0], deployMode: modes[1] });
  const stamped = [
    change("version.json", '{\n  "version": "1.0.0"\n}\n', '{\n  "version": "1.0.1"\n}\n'),
    // A dependency at the source's version keeps it: only the own entry moves.
    change("packages/cli-rs/Cargo.lock", lock("1.0.0"), lock("1.0.1")),
  ];
  const problem = (overrides) =>
    releaseCommitProblem({ deploySha: a, sourceSha: b, parents: [b], version: "1.0.1", changes: stamped, ...overrides });
  assert.equal(releaseCommitProblem({ deploySha: a, sourceSha: a, parents: [] }), null);
  assert.equal(problem({}), null);
  assert.equal(problem({ changes: [] }), null);
  assert.match(problem({ changes: [change("packages/cli-rs/Cargo.lock", lock("1.0.0"), lock("1.0.1").replace('"anstream"\nversion = "1.0.0"', '"anstream"\nversion = "1.0.1"'))] }),
    /Cargo.lock is not the 1.0.1 stamp/u);
  assert.match(problem({ changes: [...stamped, change("source.txt", "a\n", "b\n")] }), /source.txt is not a versioned file/u);
  assert.match(problem({ changes: [change("version.json", '{\n  "version": "1.0.0"\n}\n', null)] }), /added or removed/u);
  assert.match(problem({ changes: [change("version.json", '{\n  "version": "1.0.0"\n}\n', '{\n  "version": "1.0.1"\n}\n', ["100644", "100755"])] }), /changed mode/u);
  assert.match(problem({ version: "1.0.2" }), /not the 1.0.2 stamp/u);
  assert.match(problem({ parents: ["c".repeat(40)] }), /not a release commit/u);
  assert.match(problem({ parents: [b, "c".repeat(40)] }), /not a release commit/u);
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
    // Moving a dependency that happens to share the version is not a stamp.
    const dependency = repo.commit("Release 99.0.2", () => {
      repo.stamp("99.0.2")();
      const lock = path.join(repo.root, "packages/cli-rs/Cargo.lock");
      writeFileSync(lock, readFileSync(lock, "utf8").replace(/(\nname = "anstream"\nversion = )"[^"]*"/u, '$1"99.0.2"'));
    });
    assert.throws(() => verifyReleaseCommit(repo.root, dependency, smuggled), /Cargo.lock is not the 99.0.2 stamp/u);
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
