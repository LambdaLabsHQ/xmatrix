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

test("Unix CLI artifacts use the same immutable compiler installation as PR Clippy", () => {
  const ci = compilerInstalls(readYaml(".github/workflows/ci.yml").jobs["rust-cli"].steps);
  const release = compilerInstalls(readYaml(".github/workflows/cli-build.yml").jobs.build.steps);
  assert.equal(ci.length, 1, "PR must install one explicit compiler");
  assert.equal(release.length, 1, "release must install one explicit compiler");
  assert.match(ci[0].uses, /@[a-f0-9]{40}$/u, "compiler action must be immutable");
  assert.equal(release[0].uses, ci[0].uses);
  assert.equal(release[0].with?.toolchain, ci[0].with?.toolchain);
});
