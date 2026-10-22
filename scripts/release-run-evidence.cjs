"use strict";

const PRODUCTION_WORKFLOW = ".github/workflows/production-release.yml";

/** Read exact-commit evidence without GitHub's incomplete workflow search index. */
async function readWorkflowRunsForSha({ readPage, sha, workflow, branch, event }) {
  if (!/^[0-9a-f]{40}$/u.test(sha) || !/^\.github\/workflows\/[\w-]+\.ya?ml$/u.test(workflow)) {
    throw new Error("Workflow evidence requires an exact commit and workflow path");
  }
  const all = [];
  const ids = new Set();
  for (let page = 1; page <= 10; page += 1) {
    const data = await readPage({ head_sha: sha, per_page: 100, page });
    if (!Array.isArray(data?.workflow_runs) || !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 || data.total_count > 1000) {
      throw new Error("Cannot establish complete exact-commit workflow evidence");
    }
    for (const run of data.workflow_runs) {
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || ids.has(run.id)) {
        throw new Error("Workflow evidence contains invalid or repeated run identities");
      }
      ids.add(run.id);
      all.push(run);
    }
    if (all.length > data.total_count) throw new Error("Workflow evidence has inconsistent counts");
    if (all.length === data.total_count) {
      return all.filter(run => run.path === workflow && run.head_sha === sha &&
        (branch === undefined || run.head_branch === branch) &&
        (event === undefined || run.event === event)).sort((left, right) => left.id - right.id);
    }
    if (data.workflow_runs.length < 100) break;
  }
  throw new Error("Workflow evidence pagination is incomplete");
}

/** The first exact-tag production run owns the release, including its retries. */
async function readProductionState({ readPage, sha, tag }) {
  const runs = await readWorkflowRunsForSha({ readPage, sha, workflow: PRODUCTION_WORKFLOW,
    branch: tag, event: "workflow_dispatch" });
  const authority = runs[0];
  if (!authority) return "none";
  if (authority.status !== "completed" || !authority.conclusion) return "active";
  return authority.conclusion === "success" ? "success" : "failed";
}

module.exports = { readWorkflowRunsForSha, readProductionState };
