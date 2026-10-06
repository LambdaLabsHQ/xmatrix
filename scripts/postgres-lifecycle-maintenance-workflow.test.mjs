import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("the broker picks the release the executor accepts, whatever order GitHub lists runs in", () => {
  // GitHub has listed old successful releases first; a first-match pick then
  // dispatched xmatrix-v0.16.316 and xmatrix-v0.16.336 instead of the latest.
  const expression = /const production = (runs[\s\S]*?\[0\]);/u.exec(request)?.[1];
  assert.ok(expression, "the broker selects its release with one expression");
  const pick = new Function("runs", `return ${expression};`);
  const run = (id, tag, conclusion = "success") => ({ id, head_branch: tag, conclusion, event: "workflow_dispatch" });
  const runs = [run(316, "xmatrix-v0.16.316"), run(347, "xmatrix-v0.16.347"), run(348, "xmatrix-v0.16.348", "failure"),
    run(336, "xmatrix-v0.16.336"), run(349, "release-candidate")];
  assert.equal(pick(runs).head_branch, "xmatrix-v0.16.347");
  assert.equal(pick([...runs].reverse()).head_branch, "xmatrix-v0.16.347");
  // Both sides ask for an uncached run list and the broker logs what it saw.
  for (const text of [request, workflow]) assert.match(text, /uncached: String\(context\.runId\), headers: \{ "cache-control": "no-cache" \}/u);
  assert.match(request, /core\.info\(`Saw \$\{runs\.length\} successful releases/u);
});
