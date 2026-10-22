import assert from "node:assert/strict";
import test from "node:test";
import evidence from "./release-run-evidence.cjs";

const sha = "a".repeat(40);
const tag = "xmatrix-v1.5.1-beta.6";
const workflow = ".github/workflows/production-release.yml";
const run = (id, overrides = {}) => ({ id, path: workflow, head_sha: sha, head_branch: tag,
  event: "workflow_dispatch", status: "completed", conclusion: "success", ...overrides });
const reader = runs => async () => ({ total_count: runs.length, workflow_runs: runs });
const state = runs => evidence.readProductionState({ sha, tag, readPage: reader(runs) });

test("only the exact workflow, commit, tag and dispatch can establish production success", async () => {
  const unrelated = [run(1, { path: ".github/workflows/ci.yml" }), run(2, { head_sha: "b".repeat(40) }),
    run(3, { head_branch: "xmatrix-v1.5.1-beta.5" }), run(4, { event: "push" })];
  assert.equal(await state([...unrelated, run(20)]), "success");
  assert.equal(await state(unrelated), "none");
});

test("the first production run owns retries and a later duplicate cannot replace its result", async () => {
  assert.equal(await state([run(30, { conclusion: "failure" }), run(20)]), "success");
  assert.equal(await state([run(30), run(20, { conclusion: "failure" })]), "failed");
  for (const incomplete of [{ status: "queued", conclusion: null }, { status: "completed", conclusion: null }]) {
    assert.equal(await state([run(20, incomplete)]), "active");
  }
});

test("complete pagination finds authority independently of provider order", async () => {
  const archives = Array.from({ length: 100 }, (_, index) => run(100 + index,
    { path: ".github/workflows/archive-release-assets.yml" }));
  const result = await evidence.readProductionState({ sha, tag, readPage: async query => {
    assert.equal(query.head_sha, sha);
    return { total_count: 101, workflow_runs: query.page === 1 ? archives : [run(5)] };
  } });
  assert.equal(result, "success");
});

test("truncated, repeated, malformed and excessive evidence fails closed", async () => {
  for (const data of [
    { total_count: 2, workflow_runs: [run(20)] },
    { total_count: 2, workflow_runs: [run(20), run(20)] },
    { total_count: 1, workflow_runs: [run(0)] },
    { total_count: 0, workflow_runs: [run(20)] },
    { total_count: 1001, workflow_runs: [run(20)] },
    { workflow_runs: [run(20)] },
  ]) await assert.rejects(evidence.readProductionState({ sha, tag, readPage: async () => data }));
  await assert.rejects(evidence.readWorkflowRunsForSha({ sha: "short", workflow, readPage: reader([]) }), /exact commit/u);
});

test("the same reader binds contract CI evidence to its workflow and exact revision", async () => {
  const runs = await evidence.readWorkflowRunsForSha({ sha, workflow: ".github/workflows/ci.yml",
    readPage: reader([run(1), run(2, { path: ".github/workflows/ci.yml", event: "pull_request" }),
      run(3, { path: ".github/workflows/ci.yml", head_sha: "b".repeat(40) })]) });
  assert.deepEqual(runs.map(item => item.id), [2]);
});
