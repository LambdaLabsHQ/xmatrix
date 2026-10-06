import { assert, execFileSync, mkdtempSync, rmSync, writeFileSync, tmpdir, path, test } from "./script-test-fixture.mjs";
import { claimDecision, claimHolder, claimMessage, claimRef, claimRelease } from "./release-claim.mjs";

test("claims name their run and only finished holders can be displaced", () => {
  assert.equal(claimRef("xmatrix-v0.16.343"), "refs/release-claims/xmatrix-v0.16.343");
  assert.throws(() => claimRef("../heads/main"));
  const tagObject = `object ${"a".repeat(40)}\ntype commit\ntag x\ntagger T <t@x> 0 +0000\n\n${claimMessage(42)}`;
  assert.equal(claimHolder(tagObject), "42");
  assert.equal(claimHolder("object x\n\nno run here\n"), null);
  assert.deepEqual(claimDecision({ runId: 42, holder: "42", holderRun: null }), { action: "keep" });
  assert.equal(claimDecision({ runId: 7, holder: "42", holderRun: { status: "in_progress" } }).action, "refuse");
  assert.equal(claimDecision({ runId: 7, holder: "42", holderRun: { status: "completed" } }).action, "takeover");
  assert.equal(claimDecision({ runId: 7, holder: "42", holderRun: null }).action, "takeover");
  assert.equal(claimDecision({ runId: 7, holder: null, holderRun: null }).action, "takeover");
});

// Like a fresh self-hosted runner: no global git identity and no host-name guess.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "user.useConfigOnly";
process.env.GIT_CONFIG_VALUE_0 = "true";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "xmatrix-release-claim-"));
  const origin = path.join(root, "origin.git");
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  const clone = (name) => {
    const dir = path.join(root, name);
    execFileSync("git", ["clone", "--quiet", origin, dir], { stdio: "ignore" });
    run(dir, "config", "tag.gpgsign", "false");
    run(dir, "config", "commit.gpgsign", "false");
    return dir;
  };
  const first = clone("first");
  writeFileSync(path.join(first, "f"), "x\n");
  run(first, "add", "f");
  run(first, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--quiet", "-m", "c");
  run(first, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const second = clone("second");
  return { root, origin, first, second, sha: run(first, "rev-parse", "HEAD") };
}

test("one version, two requests: the running holder wins, a finished one is taken over", async () => {
  const repo = fixture();
  const tag = "xmatrix-v0.16.343";
  const runs = new Map([["100", { status: "in_progress" }]]);
  const readHolderRun = async (id) => runs.get(id) ?? null;
  try {
    assert.deepEqual(await claimRelease({ root: repo.first, tag, runId: "100", sha: repo.sha, readHolderRun }), { claimed: true });
    // A rerun of the holder keeps its claim.
    assert.deepEqual(await claimRelease({ root: repo.first, tag, runId: "100", sha: repo.sha, readHolderRun }), { claimed: true });
    await assert.rejects(
      claimRelease({ root: repo.second, tag, runId: "200", sha: repo.sha, readHolderRun }),
      /held by running request 100/u,
    );
    runs.set("100", { status: "completed" });
    assert.deepEqual(
      await claimRelease({ root: repo.second, tag, runId: "200", sha: repo.sha, readHolderRun }),
      { claimed: true, tookOverFrom: "100" },
    );
    // The displaced holder can no longer act as if it held the version.
    runs.set("200", { status: "in_progress" });
    await assert.rejects(
      claimRelease({ root: repo.first, tag, runId: "100", sha: repo.sha, readHolderRun }),
      /held by running request 200/u,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
