import assert from "node:assert/strict";
import { test } from "node:test";

import { isDependencyResolutionFailure, runGradleWithRetry } from "./android-gradle-retry.mjs";

const PLUGIN_NOT_FOUND = "- Plugin Repositories (could not resolve plugin artifact 'com.github.triplet.play:com.github.triplet.play.gradle.plugin:4.0.0')";
const BAD_POM = "> Could not parse POM https://plugins.gradle.org/m2/org/jetbrains/kotlin/kotlin-gradle-plugin/2.2.10/kotlin-gradle-plugin-2.2.10.pom";
const CLASSPATH = "Could not resolve all artifacts for configuration 'classpath'.";
const TEST_FAILURE = "Execution failed for task ':app:testDebugUnitTest'.\n> There were failing tests.";

function attempts(...results) {
  const calls = [];
  const run = async (options) => {
    calls.push(options);
    return results[calls.length - 1];
  };
  return { calls, run };
}

const quiet = { sleep: async () => {}, log: () => {} };

test("the repository failures seen on release builds count as resolution failures", () => {
  for (const output of [PLUGIN_NOT_FOUND, BAD_POM, CLASSPATH]) {
    assert.equal(isDependencyResolutionFailure(output), true, output);
  }
});

test("a failed test or lint is not a resolution failure", () => {
  assert.equal(isDependencyResolutionFailure(TEST_FAILURE), false);
  assert.equal(isDependencyResolutionFailure("Lint found errors in the project; aborting build."), false);
});

test("a resolution failure is repeated with refreshed dependencies until Gradle passes", async () => {
  const { calls, run } = attempts({ status: 1, output: PLUGIN_NOT_FOUND }, { status: 0, output: "BUILD SUCCESSFUL" });
  assert.equal(await runGradleWithRetry(run, quiet), 0);
  assert.deepEqual(calls, [{ refresh: false }, { refresh: true }]);
});

test("a failed test fails at once", async () => {
  const { calls, run } = attempts({ status: 1, output: TEST_FAILURE });
  assert.equal(await runGradleWithRetry(run, quiet), 1);
  assert.equal(calls.length, 1);
});

test("a resolution failure that lasts returns Gradle's status after the last attempt", async () => {
  const failed = { status: 7, output: BAD_POM };
  const { calls, run } = attempts(failed, failed, failed);
  assert.equal(await runGradleWithRetry(run, quiet), 7);
  assert.equal(calls.length, 3);
});
