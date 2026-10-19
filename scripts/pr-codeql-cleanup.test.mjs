import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { cleanSupersededCodeql } from "./pr-codeql-cleanup.mjs";

const repository = "example/project";
const head = "b".repeat(40);
const old = "a".repeat(40);
const repo = { full_name: repository };
const pr = { state: "open", head: { sha: head, repo }, base: { repo } };
const scan = {
  id: 10, path: "dynamic/github-code-scanning/codeql", event: "dynamic",
  head_branch: "refs/pull/12/head", head_sha: old, repository: repo,
  head_repository: repo, status: "in_progress",
};
const ancestor = { status: "ahead", base_commit: { sha: old }, merge_base_commit: { sha: old } };

// Responses represent GitHub's API boundary; the real cleanup decides what
// to compare and cancel. No pre-existing test owns this cancellation authority.
function fixture({ pull = pr, runs = [scan], comparison = ancestor, refreshed = pull, listPage, cancelError, finished } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    execute: () => cleanSupersededCodeql({
      repository, pullNumber: 12, log: () => {},
      request: async (method, route) => {
        calls.push({ method, route });
        if (method === "POST") {
          if (cancelError) throw cancelError;
          return null;
        }
        if (route.endsWith("/pulls/12")) return reads++ ? refreshed : pull;
        if (route.includes("/compare/")) return comparison;
        if (route.endsWith("/actions/runs/10")) return finished;
        const url = new URL(route, "https://api.github.com");
        assert.equal(url.pathname, `/repos/${repository}/actions/runs`);
        assert.equal(url.searchParams.get("branch"), "refs/pull/12/head");
        assert.equal(url.searchParams.get("event"), "dynamic");
        return { workflow_runs: listPage ? listPage(url.searchParams) : runs.filter((run) => run.status === url.searchParams.get("status")) };
      },
    }),
  };
}

async function assertRetained(f) {
  assert.deepEqual(await f.execute(), []);
  assert.ok(f.calls.every(({ method }) => method === "GET"));
}

test("a superseded ancestor scan is cancelled while the current scan remains", async () => {
  const f = fixture({ runs: [scan, { ...scan, id: 11, head_sha: head }] });
  assert.deepEqual(await f.execute(), [10]);
  assert.deepEqual(f.calls.filter(({ method }) => method === "POST"), [
    { method: "POST", route: `/repos/${repository}/actions/runs/10/cancel` },
  ]);
  assert.equal(f.calls.filter(({ route }) => route.includes("/compare/")).length, 1);
});

test("main, other PRs, releases, forks and completed scans grant no cancellation", async () => {
  const cases = [
    { head_branch: "main" }, { head_branch: "refs/pull/13/head" },
    { path: ".github/workflows/production-release.yml" }, { event: "workflow_dispatch" },
    { repository: { full_name: "other/project" } }, { head_repository: { full_name: "fork/project" } },
    { status: "completed" }, { head_sha: "malformed" }, { id: "10/../../11" },
  ];
  const f = fixture({ runs: cases.map((patch) => ({ ...scan, ...patch })) });
  assert.deepEqual(await f.execute(), []);
  assert.ok(f.calls.every(({ method, route }) => method === "GET" && !route.includes("/compare/")));
});

test("fork and closed PRs cannot start even a scan lookup", async () => {
  for (const pull of [
    { ...pr, state: "closed" },
    { ...pr, head: { ...pr.head, repo: { full_name: "fork/project" } } },
    { ...pr, base: { repo: { full_name: "other/project" } } },
  ]) {
    const f = fixture({ pull });
    assert.deepEqual(await f.execute(), []);
    assert.equal(f.calls.length, 1);
  }
});

test("divergence, equality and incomplete ancestry evidence retain scans", async () => {
  for (const comparison of [
    { ...ancestor, status: "diverged" }, { ...ancestor, status: "identical" },
    { ...ancestor, base_commit: { sha: head } }, { ...ancestor, merge_base_commit: { sha: head } }, {},
  ]) {
    await assertRetained(fixture({ comparison }));
  }
});

test("a concurrent head update or close stops cancellation", async () => {
  for (const refreshed of [{ ...pr, state: "closed" }, { ...pr, head: { ...pr.head, sha: "c".repeat(40) } }]) {
    await assertRetained(fixture({ refreshed }));
  }
});

test("queued scans are reclaimed and duplicate listings are idempotent", async () => {
  const f = fixture({ listPage: () => [scan, { ...scan, id: 11, status: "queued" }] });
  assert.deepEqual(await f.execute(), [10, 11]);
  assert.equal(f.calls.filter(({ route }) => route.includes("/compare/")).length, 1);
});

test("scan listing is bounded even with a full backlog", async () => {
  const f = fixture({ listPage: () => Array.from({ length: 100 }, () => ({ ...scan, head_sha: head })) });
  assert.deepEqual(await f.execute(), []);
  assert.equal(f.calls.filter(({ route }) => route.includes("/actions/runs?")).length, 6);
});

test("a GitHub evidence failure never proceeds to cancellation", async () => {
  let cancelled = false;
  await assert.rejects(cleanSupersededCodeql({ repository, pullNumber: 12, log: () => {}, request: async (method, route) => {
    if (method === "POST") { cancelled = true; return null; }
    if (route.endsWith("/pulls/12")) return pr;
    if (route.includes("/compare/")) throw new Error("GitHub unavailable");
    return { workflow_runs: [scan] };
  } }), /GitHub unavailable/u);
  assert.equal(cancelled, false);
});

test("a cancellation race is benign only after GitHub confirms completion", async () => {
  const cancelError = Object.assign(new Error("conflict"), { status: 409 });
  assert.deepEqual(await fixture({ cancelError, finished: { status: "completed" } }).execute(), []);
  await assert.rejects(fixture({ cancelError, finished: { status: "in_progress" } }).execute(), /conflict/u);
  await assert.rejects(fixture({ cancelError: new Error("forbidden") }).execute(), /forbidden/u);
});

test("privileged cleanup executes only main code and has bounded authority", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/pr-codeql-cleanup.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on.pull_request_target.types, ["synchronize", "reopened"]);
  assert.equal(workflow.permissions.actions, "write");
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.cleanup["timeout-minutes"], 5);
  const checkout = workflow.jobs.cleanup.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(workflow.jobs.cleanup.if.includes("github.ref == 'refs/heads/main'"));
});
