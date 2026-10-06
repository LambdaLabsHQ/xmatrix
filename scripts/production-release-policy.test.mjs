import { assert, execFileSync, mkdtempSync, rmSync, writeFileSync, tmpdir, path, test } from "./script-test-fixture.mjs";
import {
  productionTagFromVersion,
  productionVersionFromTag,
  validateCandidateTag,
  validateProductionRelease,
  verifyRemoteProductionTag,
} from "./production-release-policy.mjs";

const sha = "a".repeat(40);

test("production tags accept stable SemVer only", () => {
  assert.equal(productionVersionFromTag("xmatrix-v0.16.3"), "0.16.3");
  assert.equal(productionTagFromVersion("1.2.3"), "xmatrix-v1.2.3");
  for (const tag of ["v0.16.3", "xmatrix-v0.16.3-rc.1", "xmatrix-v0.16.3+build", "xmatrix-v01.2.3"]) {
    assert.throws(() => productionVersionFromTag(tag), /Invalid production tag/);
  }
});

test("the first candidate must be newer than the 0.16.2 baseline", () => {
  assert.throws(() => validateCandidateTag({ version: "0.16.2", candidateSha: sha }), /newer/);
  assert.equal(validateCandidateTag({ version: "0.16.3", candidateSha: sha }).tag, "xmatrix-v0.16.3");
});

test("candidate tags are immutable and same-SHA retries are idempotent", () => {
  assert.equal(validateCandidateTag({ version: "0.16.3", candidateSha: sha, existingTagSha: sha }).idempotent, true);
  assert.throws(
    () => validateCandidateTag({ version: "0.16.3", candidateSha: sha, existingTagSha: "b".repeat(40) }),
    /refusing to move/,
  );
});

test("production refuses mismatched tags, SHAs, and downgrades", () => {
  assert.throws(
    () => validateProductionRelease({ tag: "xmatrix-v0.16.3", version: "0.16.4", tagSha: sha, checkoutSha: sha }),
    /does not match/,
  );
  assert.throws(
    () => validateProductionRelease({ tag: "xmatrix-v0.16.3", version: "0.16.3", tagSha: sha, checkoutSha: "b".repeat(40) }),
    /does not match checkout/,
  );
  assert.throws(
    () => validateProductionRelease({ tag: "xmatrix-v0.16.3", version: "0.16.3", tagSha: sha, checkoutSha: sha, lastProductionVersion: "0.16.3" }),
    /rollback releases are not supported/,
  );
});

test("remote production tag verification detects movement", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xmatrix-production-tag-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = path.join(directory, "origin.git");
  const seed = path.join(directory, "seed");
  const checkout = path.join(directory, "checkout");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

  execFileSync("git", ["init", "--bare", origin], { stdio: "pipe" });
  execFileSync("git", ["init", seed], { stdio: "pipe" });
  git(seed, "config", "user.name", "Release Test");
  git(seed, "config", "user.email", "release-test@example.invalid");
  writeFileSync(path.join(seed, "version.json"), '{"version":"0.16.3"}\n');
  git(seed, "add", "version.json");
  git(seed, "commit", "-m", "candidate");
  const candidateSha = git(seed, "rev-parse", "HEAD");
  git(seed, "tag", "-a", "xmatrix-v0.16.3", "-m", "candidate");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "HEAD:main", "refs/tags/xmatrix-v0.16.3");
  execFileSync("git", ["clone", origin, checkout], { stdio: "pipe" });

  assert.deepEqual(
    verifyRemoteProductionTag(checkout, "xmatrix-v0.16.3", candidateSha),
    { tag: "xmatrix-v0.16.3", sha: candidateSha },
  );

  writeFileSync(path.join(seed, "version.json"), '{"version":"0.16.3","moved":true}\n');
  git(seed, "add", "version.json");
  git(seed, "commit", "-m", "moved");
  git(seed, "tag", "-f", "-a", "xmatrix-v0.16.3", "-m", "moved");
  git(seed, "push", "--force", "origin", "refs/tags/xmatrix-v0.16.3");
  assert.throws(
    () => verifyRemoteProductionTag(checkout, "xmatrix-v0.16.3", candidateSha),
    /expected immutable SHA/u,
  );
});
