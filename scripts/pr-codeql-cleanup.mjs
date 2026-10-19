// GitHub's default CodeQL setup has no repository-owned concurrency group.
// Reclaim only scans of commits superseded within the same upstream PR.
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CODEQL_PATH = "dynamic/github-code-scanning/codeql";
const ACTIVE = new Set(["queued", "in_progress"]);
const SHA = /^[0-9a-f]{40}$/u;

export async function cleanSupersededCodeql({ repository, pullNumber, request, log = console.log }) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[1-9]\d*$/u.test(String(pullNumber))) {
    throw new Error("Expected an exact repository and pull request number");
  }
  const prefix = `/repos/${repository}`;
  const pr = await request("GET", `${prefix}/pulls/${pullNumber}`);
  // Forks cannot grant write authority; closed PRs are outside this cleanup.
  if (pr.state !== "open" || pr.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository || !SHA.test(pr.head.sha)) {
    log("No open upstream PR to clean");
    return [];
  }
  const branch = `refs/pull/${pullNumber}/head`;
  const head = pr.head.sha;
  const cancelled = [];
  const comparisons = new Map();
  for (const status of ACTIVE) {
    // Bound API work even if GitHub retains an unexpectedly large backlog.
    for (let page = 1; page <= 3; page++) {
      const query = new URLSearchParams({ branch, event: "dynamic", status, per_page: "100", page: String(page) });
      const { workflow_runs: runs } = await request("GET", `${prefix}/actions/runs?${query}`);
      for (const run of runs) {
        if (run.path !== CODEQL_PATH || run.event !== "dynamic" || run.head_branch !== branch ||
            run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
            !ACTIVE.has(run.status) || !SHA.test(run.head_sha) || run.head_sha === head || !Number.isSafeInteger(run.id) || cancelled.includes(run.id)) continue;
        if (!comparisons.has(run.head_sha)) {
          const comparison = await request("GET", `${prefix}/compare/${run.head_sha}...${head}`);
          comparisons.set(run.head_sha, comparison.status === "ahead" &&
            comparison.base_commit?.sha === run.head_sha && comparison.merge_base_commit?.sha === run.head_sha);
        }
        if (!comparisons.get(run.head_sha)) continue;
        // A delayed event or concurrent update cannot authorize against a stale head.
        const current = await request("GET", `${prefix}/pulls/${pullNumber}`);
        if (current.state !== "open" || current.head?.sha !== head || current.head?.repo?.full_name !== repository) {
          log("PR changed during cleanup; leave remaining scans alone");
          return cancelled;
        }
        try {
          await request("POST", `${prefix}/actions/runs/${run.id}/cancel`);
        } catch (error) {
          if (error.status !== 409) throw error;
          // Default-setup run listings can lag behind the cancellation API.
          // A conflict grants no cancellation and proves no freed capacity.
          log(`GitHub declined cancellation of CodeQL run ${run.id} (409); left unchanged`);
          continue;
        }
        cancelled.push(run.id);
        log(`Cancelled superseded PR #${pullNumber} CodeQL run ${run.id} (${run.head_sha})`);
      }
      if (runs.length < 100) break;
    }
  }
  log(`Cancelled ${cancelled.length} superseded CodeQL run(s); current head ${head} retained`);
  return cancelled;
}

async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const number = event.pull_request?.number ?? event.inputs?.pull_number;
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  await cleanSupersededCodeql({
    repository: process.env.GITHUB_REPOSITORY,
    pullNumber: number,
    request: async (method, route) => {
      const response = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const error = new Error(`GitHub ${method} ${route.split("?")[0]} returned ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return method === "POST" || response.status === 204 ? null : response.json();
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
