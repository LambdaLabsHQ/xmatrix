import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const script = ".github/scripts/check-ci-partitions.sh";
const workflow = fs.readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

const defaultEnvironment = {
  CHANGES_RESULT: "success",
  NODE_CHANGED: "false",
  NODE_CHECKS_RESULT: "skipped",
  WEB_CHANGED: "false",
  WEB_RESULT: "skipped",
  HUB_CHANGED: "false",
  HUB_RESULT: "skipped",
  DESKTOP_CHANGED: "false",
  DESKTOP_RESULT: "skipped",
  ANDROID_CHANGED: "false",
  ANDROID_RESULT: "skipped",
  CLI_CHANGED: "false",
  RUST_CLI_RESULT: "skipped",
  RUST_CLI_WINDOWS_RESULT: "skipped",
  DUPLICATES_CHANGED: "false",
  DUPLICATES_RESULT: "skipped",
};

function bashCommand() {
  if (process.platform !== "win32") return "bash";

  const gitExecPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  assert.equal(gitExecPath.status, 0, gitExecPath.stderr);
  const gitBash = path.resolve(
    gitExecPath.stdout.trim(),
    "../../..",
    "bin",
    "bash.exe",
  );
  assert.ok(fs.existsSync(gitBash), `Git Bash is missing: ${gitBash}`);
  return gitBash;
}

function run(overrides = {}) {
  return spawnSync(bashCommand(), [script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...defaultEnvironment, ...overrides },
  });
}

test("unselected partitions may be skipped", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test("unselected first-wave gates may still succeed", () => {
  const result = run({
    NODE_CHECKS_RESULT: "success",
    HUB_RESULT: "success",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("aggregate CI materializes files hidden by stale sparse checkout state", () => {
  const aggregateJob = workflow.match(/^  ci:\r?\n[\s\S]*$/mu)?.[0];
  assert.ok(aggregateJob, "aggregate CI job is missing");

  const restoreStep = aggregateJob.indexOf(
    "- name: Restore aggregate checkout after stale sparse state",
  );
  const aggregateStep = aggregateJob.indexOf("- name: Check partitioned CI result");
  assert.ok(restoreStep >= 0, "aggregate CI checkout restore step is missing");
  assert.ok(
    aggregateStep > restoreStep,
    "aggregate result check must run after checkout restore",
  );

  const restoreContract = aggregateJob.slice(restoreStep, aggregateStep);
  for (const command of [
    "git sparse-checkout disable || true",
    "git config --worktree --unset-all core.sparseCheckout || true",
    "git config --worktree --unset-all core.sparseCheckoutCone || true",
    "git config --local --unset-all core.sparseCheckout || true",
    "git config --local --unset-all core.sparseCheckoutCone || true",
    "git read-tree -mu HEAD",
    "test -f .github/scripts/check-ci-partitions.sh",
  ]) {
    assert.ok(
      restoreContract.includes(command),
      `missing aggregate restore command: ${command}`,
    );
  }
});

function jobBlock(name) {
  return workflow.match(
    new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\r?$)`, "mu"),
  )?.[0];
}

test("the shared Node gate starts before change detection finishes", () => {
  const nodeJob = jobBlock("node-checks");
  assert.ok(nodeJob, "shared Node job is missing");
  assert.ok(nodeJob.includes("run: node scripts/ci.mjs node-checks"), "shared Node gate command changed");
  assert.doesNotMatch(nodeJob, /^    needs: changes$/mu, "shared Node waits for changes");
  assert.doesNotMatch(nodeJob, /^    if: needs\.changes\.outputs\./mu, "shared Node is selector-gated");
});

test("the Hub gate runs on every push and on pull requests that reach the Hub", () => {
  const hubJob = jobBlock("hub");
  assert.ok(hubJob, "Hub job is missing");
  // Persistent runners size the Hub pool from the host; only an ephemeral
  // hosted VM, which runs the job alone, pins it.
  for (const line of hubJob.match(/^.*XMATRIX_HUB_TEST_(?:CONCURRENCY|HOST_PRESSURE):.*$/gmu) ?? []) {
    assert.match(line, /runner\.environment == 'github-hosted' && '[^']+' \|\| ''/u, line);
  }
  assert.doesNotMatch(hubJob, /XMATRIX_HUB_TEST_BATCH_SIZE/u);
  assert.ok(hubJob.includes("run: node scripts/ci.mjs ${{ matrix.partition }}"), "Hub gate command changed");
  assert.match(hubJob, /^    needs: changes$/mu);
  assert.match(
    hubJob,
    /^    if: needs\.changes\.outputs\.hub == 'true' && !contains\(needs\.changes\.outputs\.reused, ' hub-suite '\)$/mu,
  );
  // Only a pull request selects the Hub by its diff.
  const changesJob = jobBlock("changes");
  assert.ok(changesJob.includes('if [ "$EVENT_NAME" != "pull_request" ]; then'));
  assert.ok(changesJob.includes("sed 's/^hub=.*/hub=true/'"));
});

test("a selected partition the ledger reused may be skipped", () => {
  const reused = run({ WEB_CHANGED: "true", WEB_RESULT: "skipped", REUSED: " web " });
  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /web: reused the passing result/u);
  // The Hub partition is ledgered as the whole suite.
  assert.equal(run({ HUB_CHANGED: "true", HUB_RESULT: "skipped", REUSED: " hub-suite " }).status, 0);
  const retiredName = run({ HUB_CHANGED: "true", HUB_RESULT: "skipped", REUSED: " hub " });
  assert.notEqual(retiredName.status, 0);
  // Reuse never hides a failure, and only names whole ledger jobs.
  const failed = run({ WEB_CHANGED: "true", WEB_RESULT: "failure", REUSED: " web " });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /web-required=failure/u);
  assert.notEqual(run({ CLI_CHANGED: "true", RUST_CLI_RESULT: "skipped", RUST_CLI_WINDOWS_RESULT: "success", REUSED: " rust-cli-windows " }).status, 0);
  assert.equal(run({ CLI_CHANGED: "true", RUST_CLI_RESULT: "success", RUST_CLI_WINDOWS_RESULT: "skipped", REUSED: " rust-cli-windows " }).status, 0);
});

test("every selected Node product partition must succeed", () => {
  for (const [selector, resultName, partition] of [
    ["NODE_CHANGED", "NODE_CHECKS_RESULT", "node-checks"],
    ["WEB_CHANGED", "WEB_RESULT", "web"],
    ["HUB_CHANGED", "HUB_RESULT", "hub"],
    ["DESKTOP_CHANGED", "DESKTOP_RESULT", "desktop"],
    ["ANDROID_CHANGED", "ANDROID_RESULT", "android"],
  ]) {
    const result = run({ [selector]: "true", [resultName]: "skipped" });
    assert.notEqual(result.status, 0, partition);
    assert.match(result.stderr, new RegExp(`${partition}-required=skipped`));

    const success = run({ [selector]: "true", [resultName]: "success" });
    assert.equal(success.status, 0, `${partition}: ${success.stderr}`);
  }
});

// The layout follows the same fleet rule as every runs-on selector in ci.yml:
// the caller's flag, a fork pull request, XMATRIX_RUNNER_FLEET, or (unset) a public repository.
const HOSTED_FLEET = "(inputs.hosted || github.event.pull_request.head.repo.fork || vars.XMATRIX_RUNNER_FLEET == 'github-hosted' || "
  + "(vars.XMATRIX_RUNNER_FLEET != 'self-hosted' && github.event.repository.private == false))";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function hostedMatrix(job) {
  const include = job.match(new RegExp(
    `^        include: \\$\\{\\{ fromJSON\\(${escapeRegExp(HOSTED_FLEET)} && '([^']+)' \\|\\| '([^']+)'\\) \\}\\}$`,
    "mu",
  ));
  assert.ok(include, "matrix is chosen by the fleet rule");
  return { hosted: JSON.parse(include[1]), persistent: JSON.parse(include[2]) };
}

test("the complete Hub suite runs in one job that the aggregate requires", () => {
  const hubJob = jobBlock("hub");
  assert.doesNotMatch(workflow, /^  hub-2:/mu);
  const { hosted, persistent } = hostedMatrix(hubJob);
  // A persistent runner runs the whole suite in one job named `hub`.
  assert.deepEqual(persistent, [{ name: "hub", partition: "hub", shard: "" }]);
  // A hosted run splits it into the static job and every shard of the files.
  assert.deepEqual(hosted.filter((entry) => entry.partition === "hub-static").length, 1);
  const shards = hosted.filter((entry) => entry.partition === "hub-files").map((entry) => entry.shard);
  assert.ok(shards.length > 0);
  assert.deepEqual(shards, shards.map((_, index) => `${index + 1}/${shards.length}`));
  assert.equal(hosted.length, shards.length + 1);
  const selected = { HUB_CHANGED: "true", HUB_RESULT: "success" };
  assert.equal(run(selected).status, 0);
  const failed = run({ ...selected, HUB_RESULT: "failure" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /hub-required=failure/u);
});

test("a CLI change requires both Rust partitions", () => {
  const selected = {
    CLI_CHANGED: "true",
    RUST_CLI_RESULT: "success",
    RUST_CLI_WINDOWS_RESULT: "success",
  };
  assert.equal(run(selected).status, 0);

  for (const [resultName, partition] of [
    ["RUST_CLI_RESULT", "rust-cli"],
    ["RUST_CLI_WINDOWS_RESULT", "rust-cli-windows"],
  ]) {
    const result = run({ ...selected, [resultName]: "skipped" });
    assert.notEqual(result.status, 0, partition);
    assert.match(result.stderr, new RegExp(`${partition}-required=skipped`));
  }
});

test("a source change requires the duplicate gate", () => {
  const selected = { DUPLICATES_CHANGED: "true", DUPLICATES_RESULT: "success" };
  assert.equal(run(selected).status, 0);
  const skipped = run({ ...selected, DUPLICATES_RESULT: "skipped" });
  assert.notEqual(skipped.status, 0);
  assert.match(skipped.stderr, /duplicates-required=skipped/u);
});

test("missing selector output and a non-success selector job fail closed", () => {
  assert.notEqual(run({ NODE_CHANGED: "" }).status, 0);
  assert.notEqual(run({ CHANGES_RESULT: "skipped" }).status, 0);
});

test("an unselected partition failure is not hidden", () => {
  const result = run({ WEB_RESULT: "failure" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /web-unselected=failure/);
});
