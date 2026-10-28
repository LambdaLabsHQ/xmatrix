import { assert, disableDetachedGitMaintenance, execFileSync, mkdtempSync, removeTemporaryDirectory, spawnSync, tmpdir, path, test, writeFileSync } from "./script-test-fixture.mjs";
import { fixtureRepository } from "./release-commit-test-fixture.mjs";

// The same executables a delayed component job runs, against real remote tags
// and a fully stamped checkout. Existing source/stamp tests own stamp mutation.
const scripts = ["check-release-version.mjs", "cli-entrypoint.mjs", "version.mjs", "production-release-policy.mjs",
  "release-version-order.mjs", "release-commit.mjs", "git-output.mjs"].map((name) => `scripts/${name}`);

test("a frozen component finishes after a newer parallel tag without admitting changed release identity", (t) => {
  const repo = fixtureRepository({ scripts });
  const origin = mkdtempSync(path.join(tmpdir(), "xmatrix-component-origin-"));
  t.after(() => { removeTemporaryDirectory(repo.root); removeTemporaryDirectory(origin); });
  disableDetachedGitMaintenance(repo.root);
  execFileSync("git", ["init", "--bare", "--quiet", origin], { stdio: "pipe" });
  disableDetachedGitMaintenance(origin);
  repo.git("remote", "add", "origin", origin);
  repo.git("push", "origin", "main");
  const tag = "xmatrix-v1.11.2-beta.12";
  const release = repo.cut(repo.source, "1.11.2-beta.12");
  repo.git("tag", "-a", tag, "-m", "frozen component");
  repo.git("push", "origin", tag);
  repo.cut(repo.source, "1.11.2-beta.13");
  repo.git("tag", "-a", "xmatrix-v1.11.2-beta.13", "-m", "parallel Hub");
  repo.git("push", "origin", "xmatrix-v1.11.2-beta.13");
  repo.git("checkout", "--quiet", "--detach", release);
  const run = (overrides = {}, args = ["scripts/check-release-version.mjs"]) => spawnSync(process.execPath, args, {
    cwd: repo.root, encoding: "utf8", env: { ...process.env, XMATRIX_RELEASE_BASE_REF: "",
      GITHUB_REF_NAME: tag, GITHUB_SHA: release, ...overrides },
  });
  const finished = run();
  assert.equal(finished.status, 0, finished.stderr);
  const newCut = run({}, ["scripts/version.mjs", "check-release-order", "--require-new-version"]);
  assert.notEqual(newCut.status, 0, "new release cuts still reject a version below the latest tag");
  assert.match(newCut.stderr, /downgrade detected/u);

  const wrongSha = run({ GITHUB_SHA: repo.source });
  assert.notEqual(wrongSha.status, 0);
  assert.match(wrongSha.stderr, /expected immutable SHA/u);
  const mismatched = "xmatrix-v1.11.2-beta.11";
  repo.git("tag", "-a", mismatched, "-m", "wrong version name", release);
  repo.git("push", "origin", mismatched);
  const wrongVersion = run({ GITHUB_REF_NAME: mismatched });
  assert.notEqual(wrongVersion.status, 0);
  assert.match(wrongVersion.stderr, /does not match version.json/u);
  writeFileSync(path.join(repo.root, "source.txt"), "uncommitted change\n");
  const dirty = run();
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /checkout must be clean/u);
});
