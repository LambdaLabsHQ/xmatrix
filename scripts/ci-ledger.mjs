#!/usr/bin/env node
// Content-addressed CI result ledger.
//
// A CI job's outcome is a function of the repository content it checked out.
// The same content keeps reaching CI under new commit SHAs: a squash merge
// replays the PR's tested merge tree, and the production request re-checks the
// tree main already passed. The ledger keys a job's success by that content,
// so an identical tree is verified once.
//
// Key: the Git tree of the checked-out commit, or of its source when it is a
// release commit. Nothing is excluded by directory — tests read source across
// packages, so the whole tree is the input.
//
// Record: refs/ci-ledger/<job>/<key> -> the exact commit that passed, so every
// reuse is traceable to the run that earned it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { releaseCommitProblemAt, verifyRelease, verifyReleaseCommit } from "./release-commit.mjs";
import { releaseChannel } from "./release-version-order.mjs";
import { githubRead } from "./github-read.mjs";

// The complete Hub suite, recorded under a name that never held a single
// shard's result. CI ran the suite as two jobs ("hub" and "hub-2") until
// 2026-09-27; a run from that layout proves the suite only when both passed.
export const HUB_SUITE_LEDGER_JOB = "hub-suite";

/**
 * Pure: the CI job a job result belongs to. A matrix entry is named
 * `<job> (<entry>)` (`hub (2/3)`, `web (1/4)`), a caller of the
 * reusable workflow prefixes its own job (`validate / hub (2/3)`), and the
 * Hub suite covers both retired two-job names.
 */
export function ledgerJobOf(name) {
  const job = name.replace(/^.* \/ /u, "").replace(/ \([^()]*\)$/u, "");
  return job === "hub" || job === "hub-2" ? HUB_SUITE_LEDGER_JOB : job;
}

/**
 * Pure: the ledger names a CI run's latest job results earned. A job passes
 * only when every one of its results passed, so a matrix job split over
 * several runners proves its partition only when all of them passed.
 */
export function passedLedgerJobs(jobs) {
  const results = new Map();
  for (const job of jobs) {
    // No job can claim the suite by its ledger name.
    if (job.name === HUB_SUITE_LEDGER_JOB) continue;
    const name = ledgerJobOf(job.name);
    if (!LEDGER_JOBS.has(name)) continue;
    results.set(name, (results.get(name) ?? true) && job.conclusion === "success");
  }
  return [...results].filter(([, passed]) => passed).map(([name]) => name);
}

/**
 * The CI jobs whose success the ledger records and every lookup names. The
 * `node-checks` job also runs the duplicate scan (on hosted runners as its
 * `node-checks (duplicates)` entry). Pull request CI's fast-tier jobs carry
 * other names (`node-tests`, `web-unit`, `hub-check`, ...), so they never
 * vouch for the full tier that main and release trains reuse.
 */
export const LEDGER_JOBS = new Set([
  "node-checks", "web", HUB_SUITE_LEDGER_JOB, "desktop", "android", "rust-cli", "rust-cli-windows",
]);
const JOB_NAME = /^[a-z0-9][a-z0-9-]*$/u;

function git(args, { cwd } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
}

/**
 * The ledger key: the Git tree of the commit's content. A release commit is
 * keyed by its source's tree, because it is verifiably that tree plus the
 * release version stamp (scripts/release-commit.mjs), and the train's CI
 * should reuse what the source already passed.
 */
export function currentLedgerKey(rev = "HEAD", cwd = undefined) {
  const commit = git(["rev-parse", `${rev}^{commit}`], { cwd }).trim();
  const parents = git(["rev-list", "--parents", "-n", "1", commit], { cwd }).trim().split(" ").slice(1);
  const content = parents.length === 1 && releaseCommitProblemAt(cwd ?? process.cwd(), commit, parents[0]) === null
    ? parents[0]
    : commit;
  return git(["rev-parse", `${content}^{tree}`], { cwd }).trim();
}

export function ledgerRef(job, key) {
  if (!JOB_NAME.test(job)) throw new Error(`Invalid ledger job name: ${job}`);
  return `refs/ci-ledger/${job}/${key}`;
}

/** The recorded commit of each ref that exists on origin, in one round trip. */
export function remoteCommits(refs, { cwd } = {}) {
  const commits = new Map();
  for (const line of git(["ls-remote", "origin", ...refs], { cwd }).split("\n")) {
    const [commit, ref] = line.trim().split(/\s+/u);
    if (commit && refs.includes(ref)) commits.set(ref, commit);
  }
  return commits;
}

function writeOutput(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
}

/**
 * The named jobs that already passed this exact content, so the CI selector can
 * leave them unscheduled. Like `lookup`, an unreachable ledger reuses nothing.
 */
function reused(jobs) {
  for (const job of jobs) {
    if (!LEDGER_JOBS.has(job)) throw new Error(`${job} is not a ledgered CI job`);
  }
  let hits = [];
  if (process.env.XMATRIX_CI_LEDGER === "off") {
    console.error("CI ledger disabled for this run; every job runs.");
  } else {
    const key = currentLedgerKey();
    try {
      const commits = remoteCommits(jobs.map((job) => ledgerRef(job, key)));
      hits = jobs.filter((job) => commits.has(ledgerRef(job, key)));
      for (const job of jobs) {
        const commit = commits.get(ledgerRef(job, key));
        console.error(commit
          ? `${job}: content ${key} already passed at ${commit}`
          : `${job}: no passing result for content ${key}`);
      }
    } catch (error) {
      console.error(`CI ledger unavailable (${error instanceof Error ? error.message.split("\n")[0] : error}); every job runs.`);
    }
  }
  // Space-delimited on both ends so a workflow can test ` <job> ` membership.
  writeOutput("reused", ` ${hits.join(" ")} `);
}

/** A hit only when every named job already passed this exact content. */
function lookup(jobs) {
  if (process.env.XMATRIX_CI_LEDGER === "off") {
    console.error("CI ledger disabled for this run; running the full job.");
    writeOutput("hit", "false");
    return;
  }
  for (const job of jobs) {
    if (!LEDGER_JOBS.has(job)) throw new Error(`${job} is not a ledgered CI job`);
  }
  const key = currentLedgerKey();
  let proofs;
  try {
    const commits = remoteCommits(jobs.map((job) => ledgerRef(job, key)));
    proofs = jobs.map((job) => [job, commits.get(ledgerRef(job, key))]);
  } catch (error) {
    // The ledger only ever saves work: an unreachable ledger is a miss, and the
    // job runs in full exactly as it would without one.
    console.error(`CI ledger unavailable (${error instanceof Error ? error.message.split("\n")[0] : error}); running the full job.`);
    writeOutput("key", key);
    writeOutput("hit", "false");
    return;
  }
  const hit = proofs.every(([, commit]) => commit);
  for (const [job, commit] of proofs) {
    console.error(commit
      ? `${job}: content ${key} already passed at ${commit}`
      : `${job}: no passing result for content ${key}`);
  }
  writeOutput("key", key);
  writeOutput("hit", String(hit));
}

/**
 * Pure: whether `subject` is a commit this run could have tested. A push run
 * tests its head; a pull request run tests GitHub's merge of the PR head, so
 * the merge's second parent must be that head. A release train
 * (`production-release-request.yml`, dispatched on the default branch) may
 * name its head or a single-parent child; the recorder still has to prove that
 * child with `verifyRelease` before it can vouch. Any other dispatch, including
 * Public Snapshot CI, is refused.
 */
export function subjectMatchesRun(run, subject, parents) {
  if (!/^[0-9a-f]{40}$/u.test(subject)) return false;
  if (run.event === "push") return subject === run.head_sha;
  if (run.event === "pull_request") return parents.length === 2 && parents[1] === run.head_sha;
  if (run.event === "workflow_dispatch" && run.path === ".github/workflows/production-release-request.yml") {
    if (!run.default_branch || run.head_branch !== run.default_branch) return false;
    if (subject === run.head_sha) return true;
    return parents.length === 1 && /^[0-9a-f]{40}$/u.test(parents[0] ?? "");
  }
  return false;
}

/**
 * Pure: GitHub's compare of `source...head` reports `ahead` when the source is
 * an ancestor of the head, and `identical` when they are the same commit.
 */
export function sourceContainedInHead(status) {
  return status === "ahead" || status === "identical";
}

/** Pure: the single file stored in a GitHub artifact zip. */
export function unzipSingleFile(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("artifact is not a zip archive");
  const central = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(central) !== 0x02014b50) throw new Error("artifact zip has no central directory");
  const method = zip.readUInt16LE(central + 10);
  const size = zip.readUInt32LE(central + 20);
  const local = zip.readUInt32LE(central + 42);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`unsupported artifact compression method ${method}`);
}

/**
 * Pull request CI, the public snapshot that calls it, and the release train
 * whose nested CI jobs are part of the request run rather than a CI run.
 * Public Snapshot CI is listed so a manual dispatch is recognized and then
 * refused; only the request workflow's default-branch dispatch can vouch.
 */
export const RECORDED_WORKFLOWS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/public-ci.yml",
  ".github/workflows/production-release-request.yml",
]);

const JOB_PAGE = 100;
const MAX_JOB_PAGES = 20;

/** Every job in the run. A partial page must not vouch for a matrix it did not see. */
async function listRunJobs(repo, runId, token) {
  const jobs = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const query = `filter=latest&per_page=${JOB_PAGE}${page === 1 ? "" : `&page=${page}`}`;
    const body = await githubRead(`/repos/${repo}/actions/runs/${runId}/jobs?${query}`, token);
    const batch = body.jobs ?? [];
    jobs.push(...batch);
    const total = body.total_count ?? jobs.length;
    if (batch.length < JOB_PAGE || jobs.length >= total) {
      if (jobs.length < total) throw new Error(`Run ${runId} job list ended after ${jobs.length} of ${total}`);
      return jobs;
    }
  }
  throw new Error(`Run ${runId} has too many jobs to record`);
}

/**
 * The train's artifact SHA has to be a commit its main SHA may ship. A beta
 * is that SHA or its stamp. A stable is the stamp of a source that SHA
 * contains; ancestry comes from GitHub's compare because this checkout is
 * shallow, and the stamp itself is still the local release-commit proof.
 */
async function assertReleaseTrainSubject(repo, token, headSha, subject) {
  if (subject === headSha) {
    verifyRelease(process.cwd(), subject, headSha);
    return;
  }
  const version = JSON.parse(git(["show", `${subject}:version.json`])).version;
  if (releaseChannel(version) !== "stable") {
    verifyRelease(process.cwd(), subject, headSha);
    return;
  }
  const parents = git(["rev-list", "--parents", "-n", "1", subject]).trim().split(" ").slice(1);
  const parent = parents[0];
  if (parents.length !== 1 || !/^[0-9a-f]{40}$/u.test(parent ?? "")) {
    throw new Error(`${subject} is not a single-parent release commit`);
  }
  const compared = await githubRead(`/repos/${repo}/compare/${parent}...${headSha}`, token);
  if (!sourceContainedInHead(compared.status)) {
    throw new Error(`${subject} was cut from ${parent}, which ${headSha} does not contain`);
  }
  verifyReleaseCommit(process.cwd(), subject, parent);
}

/**
 * Record the ledgered jobs one CI run passed. Runs from the default branch in
 * the ci-ledger workflow — never inside CI, which executes PR code and holds no
 * write token. The key is re-derived here from the verified tested commit, so
 * a run can only ever vouch for the content it actually checked out.
 */
async function recordRun(runId) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const run = await githubRead(`/repos/${repo}/actions/runs/${runId}`, token);
  if (!RECORDED_WORKFLOWS.has(run.path) || run.head_repository?.full_name !== repo) {
    console.error(`Run ${runId} is not this repository's CI; nothing recorded.`);
    return;
  }
  const jobs = await listRunJobs(repo, runId, token);
  const passed = passedLedgerJobs(jobs);
  if (passed.length === 0) {
    console.error(`Run ${runId} passed no ledgered job; nothing recorded.`);
    return;
  }
  const { artifacts } = await githubRead(`/repos/${repo}/actions/runs/${runId}/artifacts?name=ci-ledger-subject`, token);
  if (!artifacts?.length) {
    // Runs whose workflow predates the ledger, or that were cancelled before
    // naming their commit, simply record nothing.
    console.error(`Run ${runId} published no ci-ledger-subject; nothing recorded.`);
    return;
  }
  const zip = await githubRead(new URL(artifacts[0].archive_download_url).pathname, token, { binary: true });
  const subject = String(JSON.parse(unzipSingleFile(zip).toString("utf8")).sha ?? "");
  git(["fetch", "--no-tags", "--depth=2", "origin", subject]);
  const parents = git(["rev-list", "--parents", "-n", "1", subject]).trim().split(" ").slice(1);
  const checked = { ...run, default_branch: process.env.DEFAULT_BRANCH };
  if (!subjectMatchesRun(checked, subject, parents)) {
    throw new Error(`Run ${runId} (${run.event} ${run.head_sha}) did not test ${subject}`);
  }
  // Push and pull request runs are bound by their head. A train's child commit
  // still has to be the release stamp that head may ship.
  if (run.event === "workflow_dispatch") await assertReleaseTrainSubject(repo, token, run.head_sha, subject);
  const key = currentLedgerKey(subject);
  // One round trip to list what is already recorded and one push for the
  // rest: each call reaches GitHub from the runner's network, so a per-job
  // query and push made recording the slowest part of this job.
  const refs = new Map(passed.map((job) => [ledgerRef(job, key), job]));
  const recorded = remoteCommits([...refs.keys()]);
  for (const [ref, job] of refs) {
    if (recorded.has(ref)) console.error(`${job}: ${key} already recorded`);
  }
  const missing = [...refs.keys()].filter((ref) => !recorded.has(ref));
  if (missing.length === 0) return;
  try {
    git(["push", "--no-verify", "origin", ...missing.map((ref) => `${subject}:${ref}`)]);
    for (const ref of missing) console.error(`${refs.get(ref)}: recorded ${key} -> ${subject} (run ${runId})`);
  } catch (error) {
    // A concurrent recorder may win some refs; each ref is pushed on its own
    // (not atomically), and the ledger is a cache, so a lost write only costs
    // a future re-run.
    console.error(`could not record every job for ${key}: ${error instanceof Error ? error.message : error}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "key") {
    process.stdout.write(`${currentLedgerKey(args[0])}\n`);
  } else if (command === "lookup" && args.length > 0) {
    lookup(args);
  } else if (command === "reused" && args.length > 0) {
    reused(args);
  } else if (command === "record-run" && /^\d+$/u.test(args[0] ?? "")) {
    await recordRun(args[0]);
  } else {
    console.error("Usage: node scripts/ci-ledger.mjs key [rev] | lookup <job>... | reused <job>... | record-run <ci-run-id>");
    process.exit(2);
  }
}
