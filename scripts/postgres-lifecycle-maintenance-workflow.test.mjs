import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

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
async function broker(runs) {
  const step = parse(request).jobs.dispatch.steps.find((item) => item.name === "Dispatch from the latest successful production tag");
  const script = new (Object.getPrototypeOf(async function () {}).constructor)("github", "context", "core", "process", step.with.script);
  const shaOf = (tag) => runs.find((run) => run.head_branch === tag).head_sha;
  const dispatched = [];
  const github = {
    paginate: async () => runs,
    rest: {
      actions: {
        listWorkflowRuns: () => {},
        createWorkflowDispatch: async ({ workflow_id, ref }) => { dispatched.push({ workflow_id, ref }); },
      },
      git: {
        getRef: async ({ ref }) => ({ data: { object: { type: "tag", sha: `tag-object:${ref.slice("tags/".length)}` } } }),
        getTag: async ({ tag_sha }) => ({ data: { object: { type: "commit", sha: shaOf(tag_sha.slice("tag-object:".length)) } } }),
      },
    },
  };
  await script(github, { eventName: "schedule", runId: 7, repo: {} }, { info: () => {}, notice: () => {} },
    { env: { REQUEST_DRY_RUN: "", REQUEST_MAX_ROWS: "" } });
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
  // stable that rebuilt an older beta's source for clients only.
  const channels = [...legacy, run(400, "xmatrix-v0.16.349-beta.2"), run(401, "xmatrix-v0.16.349-beta.3", "failure"),
    run(402, "xmatrix-v0.17.0")];
  for (const runs of [channels, [...channels].reverse()]) {
    assert.deepEqual(await broker(runs), [{ workflow_id: "production-postgres-lifecycle-maintenance.yml", ref: "xmatrix-v0.16.349-beta.2" }]);
  }
  // Both sides ask for an uncached run list and the broker logs what it saw.
  for (const text of [request, workflow]) assert.match(text, /uncached: String\(context\.runId\), headers: \{ "cache-control": "no-cache" \}/u);
  assert.match(request, /core\.info\(`Saw \$\{runs\.length\} successful releases/u);
});
