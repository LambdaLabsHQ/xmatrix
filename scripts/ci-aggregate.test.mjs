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
  CLI_WINDOWS_CHANGED: "false",
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
  const cli = { CLI_CHANGED: "true", CLI_WINDOWS_CHANGED: "true" };
  assert.notEqual(run({ ...cli, RUST_CLI_RESULT: "skipped", RUST_CLI_WINDOWS_RESULT: "success", REUSED: " rust-cli-windows " }).status, 0);
  assert.equal(run({ ...cli, RUST_CLI_RESULT: "success", RUST_CLI_WINDOWS_RESULT: "skipped", REUSED: " rust-cli-windows " }).status, 0);
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

test("a full-tier CLI change requires both Rust partitions", () => {
  const selected = {
    CLI_CHANGED: "true",
    CLI_WINDOWS_CHANGED: "true",
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

test("a pull request's CLI change requires only the Linux Rust job", () => {
  const fast = { CLI_CHANGED: "true", RUST_CLI_RESULT: "success", RUST_CLI_WINDOWS_RESULT: "skipped" };
  assert.equal(run(fast).status, 0);
  const failed = run({ ...fast, RUST_CLI_WINDOWS_RESULT: "failure" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /rust-cli-windows-unselected=failure/u);
  assert.notEqual(run({ ...fast, RUST_CLI_RESULT: "skipped" }).status, 0);
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
