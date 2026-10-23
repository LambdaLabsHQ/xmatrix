import assert from "node:assert/strict";
import test from "node:test";

import {
  latestMaintenanceRelease,
  lifecycleExecutionTitle,
  lifecycleRequestTitle,
  requireLifecycleExecutionAuthority,
} from "./postgres-lifecycle-maintenance-policy.mjs";

const tag = "xmatrix-v0.16.238";
const sha = "a".repeat(40);
const broker = {
  id: 41,
  path: ".github/workflows/production-postgres-lifecycle-maintenance-request.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  conclusion: "success",
  display_title: lifecycleRequestTitle("true", "10000"),
};

function valid(overrides = {}) {
  return {
    broker,
    productionRuns: [{ id: 40, conclusion: "success", event: "workflow_dispatch", head_branch: tag, head_sha: sha }],
    sameTagRuns: [{ id: 42, display_title: lifecycleExecutionTitle(41, "true", "10000") }],
    tag,
    tagCommitSha: sha,
    currentRunId: 42,
    currentDisplayTitle: lifecycleExecutionTitle(41, "true", "10000"),
    currentSha: sha,
    dryRun: "true",
    maxRows: "10000",
    brokerIsInMain: true,
    ...overrides,
  };
}

test("lifecycle execution accepts one exact production-tag broker receipt", () => {
  assert.deepEqual(requireLifecycleExecutionAuthority(valid()), {
    brokerRunId: "41", dryRun: true, maxRows: 10000,
  });
});

test("the daily schedule's million-row ceiling is an accepted parameter", () => {
  const scheduled = { ...broker, event: "schedule", display_title: lifecycleRequestTitle("false", "1000000") };
  assert.deepEqual(requireLifecycleExecutionAuthority(valid({
    broker: scheduled, dryRun: "false", maxRows: "1000000",
    sameTagRuns: [{ id: 42, display_title: lifecycleExecutionTitle(41, "false", "1000000") }],
    currentDisplayTitle: lifecycleExecutionTitle(41, "false", "1000000"),
  })), { brokerRunId: "41", dryRun: false, maxRows: 1000000 });
});

test("lifecycle execution rejects authority, parameter, and replay drift", () => {
  for (const input of [
    valid({ tagCommitSha: "b".repeat(40) }),
    valid({ productionRuns: [] }),
    valid({ productionRuns: [
      { id: 40, conclusion: "success", event: "workflow_dispatch", head_branch: tag, head_sha: sha },
      { id: 44, conclusion: "success", event: "workflow_dispatch",
        head_branch: "xmatrix-v0.16.239", head_sha: "c".repeat(40) },
    ] }),
    valid({ broker: { ...broker, path: ".github/workflows/other.yml" } }),
    valid({ broker: { ...broker, head_branch: "feature" } }),
    valid({ broker: { ...broker, display_title: lifecycleRequestTitle("false", "10000") } }),
    valid({ currentDisplayTitle: lifecycleExecutionTitle("041", "true", "10000") }),
    valid({ sameTagRuns: [
      { id: 42, display_title: lifecycleExecutionTitle(41, "true", "10000") },
      { id: 43, display_title: lifecycleExecutionTitle(41, "true", "10000") },
    ] }),
  ]) assert.throws(() => requireLifecycleExecutionAuthority(input));
});

test("maintenance runs from the newest beta, never from a stable that rebuilt an older source", () => {
  const run = (id, head_branch, conclusion = "success") =>
    ({ id, conclusion, event: "workflow_dispatch", head_branch, head_sha: String(id).padStart(40, "0") });
  // Before the first beta, the newest release of the old single line.
  assert.equal(latestMaintenanceRelease([run(40, "xmatrix-v1.0.605"), run(41, "xmatrix-v1.0.606")]).id, 41);
  const runs = [run(41, "xmatrix-v1.0.606"), run(50, "xmatrix-v1.0.607-beta.2"), run(51, "xmatrix-v1.0.607-beta.3", "failure"),
    run(52, "xmatrix-v1.1.0"), run(53, "xmatrix-v1.0.607-rc.1")];
  assert.equal(latestMaintenanceRelease(runs).head_branch, "xmatrix-v1.0.607-beta.2");
  const betaTag = "xmatrix-v1.0.607-beta.2";
  const betaSha = run(50, betaTag).head_sha;
  assert.deepEqual(requireLifecycleExecutionAuthority(valid({ tag: betaTag, tagCommitSha: betaSha, currentSha: betaSha,
    productionRuns: runs })), { brokerRunId: "41", dryRun: true, maxRows: 10000 });
  const stableSha = run(52, "xmatrix-v1.1.0").head_sha;
  assert.throws(() => requireLifecycleExecutionAuthority(valid({ tag: "xmatrix-v1.1.0", tagCommitSha: stableSha,
    currentSha: stableSha, productionRuns: runs })), /not the latest successful exact-SHA Production Release/u);
});
