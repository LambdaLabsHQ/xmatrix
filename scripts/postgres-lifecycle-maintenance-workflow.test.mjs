import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

// A file URL keeps the dynamic import valid on every runner path style.
const workspace = pathToFileURL(fileURLToPath(new URL("..", import.meta.url))).href.replace(/\/$/u, "");

const workflow = await readFile(new URL(
  "../.github/workflows/production-postgres-lifecycle-maintenance.yml",
  import.meta.url,
), "utf8");
const request = await readFile(new URL(
  "../.github/workflows/production-postgres-lifecycle-maintenance-request.yml",
  import.meta.url,
), "utf8");

test("maintenance preflight installs pinned dependencies after authority and before operator checks", () => {
  const preflight = workflow.split("  preflight:")[1].split("  maintain:")[0];
  const authority = preflight.indexOf('core.setOutput("maintenance_sha", context.sha)');
  const setup = preflight.indexOf("uses: ./.github/actions/setup-pnpm-node");
  const verification = preflight.indexOf("name: Verify exact tagged source and bounded operator");
  assert.ok(authority >= 0 && setup > authority && verification > setup);
  assert.doesNotMatch(preflight, /secrets\.|environment: production/u);
  assert.match(preflight, /test -z "\$\(git status --porcelain\)"/u);
});

test("both maintenance jobs restore the full tagged tree before any local action", () => {
  for (const job of [workflow.split("  preflight:")[1].split("  maintain:")[0], workflow.split("  maintain:")[1]]) {
    const materialize = job.indexOf("name: Materialize the full tagged tree");
    const firstLocal = job.indexOf("uses: ./.github/actions/");
    assert.ok(materialize > job.indexOf("uses: actions/checkout@v6") && firstLocal > materialize);
    assert.match(job, /git read-tree -mu HEAD/u);
  }
});

// Runs the broker's own script against a fake GitHub that lists `runs` and
// returns what it dispatched.
async function broker(runs, { releaseAfterMs = 0, tagType = "tag", tagSha, dispatched = [], elapsed = { ms: 0 } } = {}) {
  const step = parse(request).jobs.dispatch.steps.find((item) => item.name === "Dispatch from the latest successful production tag");
  const script = new (Object.getPrototypeOf(async function () {}).constructor)("github", "context", "core", "process", "Date", "setTimeout", step.with.script);
  const shaOf = (tag) => runs.find((run) => run.head_branch === tag).head_sha;
  const newer = { id: 500, head_branch: "xmatrix-v0.17.1-beta.1", head_sha: "b".repeat(40), event: "workflow_dispatch" };
  const github = {
    paginate: async (_method, params) => {
      const active = elapsed.ms < releaseAfterMs;
      if (params.status === "in_progress" || params.status === "queued") {
        return active && params.status === "in_progress" ? [{ ...newer, status: "in_progress" }] : [];
      }
      return releaseAfterMs && !active ? [...runs, { ...newer, conclusion: "success" }] : runs;
    },
    rest: {
      actions: {
        listWorkflowRuns: () => {},
        createWorkflowDispatch: async ({ workflow_id, ref }) => { dispatched.push({ workflow_id, ref }); },
      },
      git: {
        getRef: async ({ ref }) => ({ data: { object: { type: tagType, sha: `tag-object:${ref.slice("tags/".length)}` } } }),
        getTag: async ({ tag_sha }) => ({ data: { object: { type: "commit", sha: tagSha ?? (tag_sha.endsWith(newer.head_branch) ? newer.head_sha : shaOf(tag_sha.slice("tag-object:".length))) } } }),
      },
    },
  };
  await script(github, { eventName: "schedule", runId: 7, repo: {} }, { info: () => {}, notice: () => {} },
    { env: { GITHUB_WORKSPACE: workspace, REQUEST_DRY_RUN: "", REQUEST_MAX_ROWS: "" } },
    class extends Date { static now() { return Date.UTC(2026, 10, 1) + elapsed.ms; } },
    (callback, ms) => { elapsed.ms += ms; callback(); });
  return dispatched;
}

test("the broker dispatches the release the executor accepts, whatever order GitHub lists runs in", async () => {
  // GitHub has listed old successful releases first; a first-match pick then
  // dispatched xmatrix-v0.16.316 and xmatrix-v0.16.336 instead of the latest.
  const run = (id, tag, conclusion = "success") =>
    ({ id, head_branch: tag, conclusion, event: "workflow_dispatch", head_sha: String(id).padStart(40, "0") });
  const legacy = [run(316, "xmatrix-v0.16.316"), run(347, "xmatrix-v0.16.347"), run(348, "xmatrix-v0.16.348", "failure"),
    run(336, "xmatrix-v0.16.336"), run(349, "release-candidate")];
  for (const runs of [legacy, [...legacy].reverse()]) {
    assert.deepEqual(await broker(runs), [{ workflow_id: "production-postgres-lifecycle-maintenance.yml", ref: "xmatrix-v0.16.347" }]);
  }
  // Once betas exist the newest beta, which deploys the Hub, wins over a later
  // stable that rebuilt an older beta's source, which never deploys the Hub.
  const channels = [...legacy, run(400, "xmatrix-v0.16.349-beta.2"), run(401, "xmatrix-v0.16.349-beta.3", "failure"),
    run(402, "xmatrix-v0.17.0")];
  for (const runs of [channels, [...channels].reverse()]) {
    assert.deepEqual(await broker(runs), [{ workflow_id: "production-postgres-lifecycle-maintenance.yml", ref: "xmatrix-v0.16.349-beta.2" }]);
  }
  // Both sides ask for an uncached run list and the broker logs what it saw.
  assert.match(request, /uncached: `\$\{context\.runId\}-\$\{Date\.now\(\)\}`, headers: \{ "cache-control": "no-cache" \}/u);
  assert.match(workflow, /uncached: String\(context\.runId\), headers: \{ "cache-control": "no-cache" \}/u);
  assert.match(request, /core\.info\(`Saw \$\{history\.length\} successful releases and \$\{recent\.length\} since \$\{day\}/u);
});

// The policy's selection tests do not exercise the workflow's wait budget.
// Run the actual broker script: a normal release must not skip the daily pass.
test("the broker waits through normal and p90 releases and dispatches their new immutable tag", async () => {
  const runs = [{ id: 400, head_branch: "xmatrix-v0.17.0-beta.1", head_sha: "a".repeat(40),
    conclusion: "success", event: "workflow_dispatch" }];
  for (const minutes of [9, 26]) {
    const elapsed = { ms: 0 };
    assert.deepEqual(await broker(runs, { releaseAfterMs: minutes * 60_000, elapsed }),
      [{ workflow_id: "production-postgres-lifecycle-maintenance.yml", ref: "xmatrix-v0.17.1-beta.1" }]);
    assert.ok(elapsed.ms >= minutes * 60_000);
    assert.ok(elapsed.ms < 45 * 60_000);
  }
});

test("a stuck release exhausts a bounded wait without dispatching the stale tag", async () => {
  const elapsed = { ms: 0 }, dispatched = [];
  const runs = [{ id: 400, head_branch: "xmatrix-v0.17.0-beta.1", head_sha: "a".repeat(40),
    conclusion: "success", event: "workflow_dispatch" }];
  await assert.rejects(broker(runs, { releaseAfterMs: Infinity, elapsed, dispatched }), /newer Production Release/u);
  assert.deepEqual(dispatched, []);
  assert.equal(elapsed.ms, 45 * 60_000);
  assert.ok(parse(request).jobs.dispatch["timeout-minutes"] >= elapsed.ms / 60_000 + 10,
    "the job must leave time for API reads, checkout and immutable-tag verification");
});

test("waiting never bypasses the annotated-tag and exact-SHA fences", async () => {
  const runs = [{ id: 400, head_branch: "xmatrix-v0.17.0-beta.1", head_sha: "a".repeat(40),
    conclusion: "success", event: "workflow_dispatch" }];
  for (const drift of [{ tagType: "commit" }, { tagSha: "c".repeat(40) }]) {
    const dispatched = [];
    await assert.rejects(broker(runs, { releaseAfterMs: 9 * 60_000, dispatched, ...drift }), /production tag/u);
    assert.deepEqual(dispatched, []);
  }
});
