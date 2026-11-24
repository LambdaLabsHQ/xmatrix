import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

function readYaml(file) {
  return parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
}

// Follow composite actions so moving setup between files preserves this test.
// This is a release-workflow contract: a green PR must validate the compiler
// that will build its published Unix artifacts, rather than the runner image.
function compilerInstalls(steps) {
  return steps.flatMap((step) => {
    if (step.if === "runner.os == 'Windows'") return [];
    if (step.uses?.startsWith("dtolnay/rust-toolchain@")) return [step];
    if (step.uses?.startsWith("./")) {
      return compilerInstalls(readYaml(`${step.uses}/action.yml`).runs.steps);
    }
    return [];
  });
}

test("Unix CLI artifacts and release cache use the same immutable compiler installation as PR Clippy", () => {
  const ci = compilerInstalls(readYaml(".github/workflows/ci.yml").jobs["rust-cli"].steps);
  const release = compilerInstalls(readYaml(".github/workflows/cli-build.yml").jobs.build.steps);
  const cache = compilerInstalls(readYaml(".github/workflows/cli-release-cache.yml").jobs.warm.steps);
  assert.equal(ci.length, 1, "PR must install one explicit compiler");
  assert.equal(release.length, 1, "release must install one explicit compiler");
  assert.equal(cache.length, 1, "release cache must install one explicit compiler");
  assert.match(ci[0].uses, /@[a-f0-9]{40}$/u, "compiler action must be immutable");
  assert.equal(release[0].uses, ci[0].uses);
  assert.equal(release[0].with?.toolchain, ci[0].with?.toolchain);
  assert.equal(cache[0].uses, ci[0].uses);
  assert.equal(cache[0].with?.toolchain, ci[0].with?.toolchain);
});

// Setup Windows Rust CLI strips Git Bash from PATH so Cargo/MSVC never pick up
// MSYS tools; any later `shell: bash` step on Windows falls back to WSL and fails.
test("Windows CLI release build steps never invoke bash", () => {
  const steps = readYaml(".github/workflows/cli-build.yml").jobs.build.steps;
  const bad = steps.filter(
    (step) =>
      step.shell === "bash" &&
      !(typeof step.if === "string" && /runner\.os\s*(?:!=\s*'Windows'|==\s*'(?:Linux|macOS)')/u.test(step.if)),
  );
  assert.deepEqual(
    bad.map((step) => step.name ?? step.id ?? "<unnamed>"),
    [],
    "cli-build.yml build job has shell: bash step reachable on Windows",
  );
});

// Requesting two concurrent `macos-26` VMs per CLI release or cache warm hit
// GitHub's Apple Silicon pool capacity and cancelled the second job after 15m.
// Both workflows must request one macOS VM while still covering both macOS
// targets (`aarch64-apple-darwin` / `macos-arm64` and `x86_64-apple-darwin` /
// `macos-x64`).
test("macOS CLI release and cache warm use one Apple Silicon job for both architectures", () => {
  for (const [file, jobName] of [
    [".github/workflows/cli-build.yml", "build"],
    [".github/workflows/cli-release-cache.yml", "warm"],
  ]) {
    const entries = readYaml(file).jobs[jobName].strategy.matrix.include;
    const macEntries = entries.filter((entry) => String(entry.target).includes("apple-darwin"));
    assert.equal(macEntries.length, 1, `${file} must schedule exactly one macOS job`);
    const [mac] = macEntries;
    assert.match(String(mac.runner), /macos-26/u);
    assert.equal(mac.primary_target, "aarch64-apple-darwin");
    assert.equal(mac.secondary_target, "x86_64-apple-darwin");
    assert.equal(mac.part, "macos-arm64");
    assert.equal(mac.secondary_part, "macos-x64");
    assert.deepEqual(
      String(mac.target).split(",").map((target) => target.trim()).sort(),
      ["aarch64-apple-darwin", "x86_64-apple-darwin"],
    );
  }
});
