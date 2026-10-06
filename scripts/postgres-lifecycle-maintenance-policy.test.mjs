import assert from "node:assert/strict";
import test from "node:test";

import {
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
