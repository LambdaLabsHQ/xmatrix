import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const readYaml = (file) => parse(readFileSync(new URL(file, root), "utf8"));
const request = readYaml(".github/workflows/production-release-request.yml");

// This release boundary used to name a model on OS=latest, even when the runner
// only had an older compatible runtime. Exercise the actual gate with simctl's
// external inventory; existing authorization tests do not execute this gate.
function runGate(t, devices, buildStatus = 0) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ios-simulator-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invocation = path.join(dir, "xcodebuild.json");
  writeFileSync(path.join(dir, "devices.json"), JSON.stringify({ devices }));
  writeFileSync(path.join(dir, "xcrun"), '#!/bin/sh\ncat "$SIMULATOR_FIXTURE"\n', { mode: 0o755 });
  writeFileSync(path.join(dir, "xcodebuild"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.BUILD_INVOCATION, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.BUILD_STATUS));
`, { mode: 0o755 });
  const steps = request.jobs.ios.steps.flatMap((step) => step.uses?.startsWith("./")
    ? readYaml(`${step.uses}/action.yml`).runs.steps : [step]);
  const build = steps.find((step) => step.name?.startsWith("Build and test"));
  assert.equal(typeof build?.run, "string");
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", build.run], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      SIMULATOR_FIXTURE: path.join(dir, "devices.json"), BUILD_INVOCATION: invocation,
      BUILD_STATUS: String(buildStatus) },
  });
  return { ...result, args: (() => {
    try { return JSON.parse(readFileSync(invocation, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  })() };
}

const device = (name, udid) => ({ name, udid, isAvailable: true });
const compatible = { "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [device("iPhone 16", "installed-iphone")] };

test("release gate tests an installed iOS 26 iPhone even when the latest SDK has no runtime", (t) => {
  const result = runGate(t, {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [device("iPhone 18 Pro", "wrong-ios")],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-6": [device("iPad Pro", "not-an-iphone")],
    ...compatible,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.args, ["-project", "apps/ios/xMatrix.xcodeproj", "-scheme", "xMatrix",
    "-destination", "platform=iOS Simulator,id=installed-iphone", "CODE_SIGNING_ALLOWED=NO", "test"]);
});

test("release simulator gate fails closed without a compatible iPhone and propagates test failures", (t) => {
  const missing = runGate(t, { "com.apple.CoreSimulator.SimRuntime.iOS-25-0": [device("iPhone 16", "old-ios")] });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.args, null);
  assert.match(missing.stderr, /No iPhone simulator on an iOS 26 runtime/u);
  assert.equal(runGate(t, compatible, 65).status, 65);
});

test("PR CI exercises the same simulator gate and production keeps its exact revision and prerequisites", () => {
  const pr = readYaml(".github/workflows/ios-ci.yml");
  const action = request.jobs.ios.steps.find((step) => step.uses?.startsWith("./")).uses;
  assert.ok(pr.jobs.test.steps.some((step) => step.uses === action));
  assert.ok(pr.on.pull_request.paths.includes(`${action.slice(2)}/**`));
  const checkout = request.jobs.ios.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ needs.plan.outputs.deploy_sha }}");
  const gates = request.jobs.gates;
  assert.ok(gates.needs.includes("ios"));
  const permits = new Function("needs", "always", "contains", "format", `return (${gates.if});`);
  const needs = { plan: { result: "success", outputs: { scope: "ios", channel: "stable" } }, ci: { result: "success" }, ios: { result: "success" } };
  const evaluate = () => permits(needs, () => true, (value, part) => value.includes(part), (_, scope) => `,${scope},`);
  assert.equal(evaluate(), true);
  for (const result of ["failure", "skipped", "cancelled"]) {
    needs.ios.result = result;
    assert.equal(evaluate(), false, result);
  }
  // A beta reaches TestFlight only; the simulator gate waits for the stable.
  needs.plan.outputs.channel = "beta";
  needs.ios.result = "skipped";
  assert.equal(evaluate(), true);
  needs.ios.result = "failure";
  assert.equal(evaluate(), false);
});
