#!/usr/bin/env node
// Content-addressed CI result ledger.
//
// A CI job's outcome is a function of the repository content it checked out.
// The same content keeps reaching CI under new commit SHAs: a squash merge
// replays the PR's tested merge tree, a version bump changes nothing but the
// version, and the production request re-checks the tree the PR already passed.
// The ledger keys a job's success by that content, so an identical tree is
// verified once.
//
// Key: every tracked path, mode and blob of the checked-out commit; the files a
// version bump rewrites are hashed with the release version replaced, so a bump
// alone never invalidates a result. Nothing is excluded by directory — tests
// read source across packages, so the whole tree is the input.
//
// Record: refs/ci-ledger/<job>/<key> -> the exact commit that passed, so every
// reuse is traceable to the run that earned it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { versionedPaths } from "./version.mjs";

const LEDGER_VERSION = "ci-ledger-v1";
// The complete Hub suite, recorded under a name that never held a single
// shard's result. CI ran the suite as two jobs ("hub" and "hub-2") until
// 2026-09-27; a run from that layout proves the suite only when both passed.
export const HUB_SUITE_LEDGER_JOB = "hub-suite";

/**
 * Pure: the CI job a job result belongs to. A matrix entry is named
 * `<job> (<entry>)` (`hub (3/6)`, `web (browser 1/4)`), and the Hub suite
 * covers both retired two-job names.
 */
export function ledgerJobOf(name) {
  const job = name.replace(/ \([^()]*\)$/u, "");
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

/** The CI jobs whose success the ledger records and every lookup names. */
export const LEDGER_JOBS = new Set([
  "node-checks", "web", HUB_SUITE_LEDGER_JOB, "desktop", "android", "rust-cli", "rust-cli-windows", "duplicates",
]);
const JOB_NAME = /^[a-z0-9][a-z0-9-]*$/u;

function git(args, { cwd } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Pure: the ledger key for a `git ls-tree -r -z` listing plus the versioned files' contents. */
export function ledgerKey(lsTree, versionedContents, version) {
  const normalized = new Map(
    Object.entries(versionedContents).map(([file, text]) => [
      file,
      `normalized:${sha256(text.split(version).join("\0version\0"))}`,
    ]),
  );
  const entries = lsTree.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    return `${mode} ${type} ${normalized.get(file) ?? object}\t${file}`;
  });
  return sha256(`${LEDGER_VERSION}\n${entries.join("\n")}`).slice(0, 40);
}

export function currentLedgerKey(rev = "HEAD", cwd = undefined) {
  const version = JSON.parse(git(["show", `${rev}:version.json`], { cwd })).version;
  const versionedContents = {};
  for (const file of versionedPaths) {
    versionedContents[file] = git(["show", `${rev}:${file}`], { cwd });
  }
  return ledgerKey(git(["ls-tree", "-r", "-z", rev], { cwd }), versionedContents, version);
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
 * the merge's second parent must be that head. Anything else is refused.
 */
export function subjectMatchesRun(run, subject, parents) {
  if (!/^[0-9a-f]{40}$/u.test(subject)) return false;
  if (run.event === "push") return subject === run.head_sha;
  if (run.event === "pull_request") return parents.length === 2 && parents[1] === run.head_sha;
  return false;
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

async function github(pathname, token) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub ${pathname}: ${response.status}`);
  return response;
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
  const run = await (await github(`/repos/${repo}/actions/runs/${runId}`, token)).json();
  if (run.path !== ".github/workflows/ci.yml" || run.head_repository?.full_name !== repo) {
    console.error(`Run ${runId} is not this repository's CI; nothing recorded.`);
    return;
  }
  const { jobs } = await (await github(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, token)).json();
  const passed = passedLedgerJobs(jobs);
  if (passed.length === 0) {
    console.error(`Run ${runId} passed no ledgered job; nothing recorded.`);
    return;
  }
  const { artifacts } = await (await github(`/repos/${repo}/actions/runs/${runId}/artifacts?name=ci-ledger-subject`, token)).json();
  if (!artifacts?.length) {
    // Runs whose workflow predates the ledger, or that were cancelled before
    // naming their commit, simply record nothing.
    console.error(`Run ${runId} published no ci-ledger-subject; nothing recorded.`);
    return;
  }
  const zip = Buffer.from(await (await github(new URL(artifacts[0].archive_download_url).pathname, token)).arrayBuffer());
  const subject = String(JSON.parse(unzipSingleFile(zip).toString("utf8")).sha ?? "");
  git(["fetch", "--no-tags", "--depth=2", "origin", subject]);
  const parents = git(["rev-list", "--parents", "-n", "1", subject]).trim().split(" ").slice(1);
  if (!subjectMatchesRun(run, subject, parents)) {
    throw new Error(`Run ${runId} (${run.event} ${run.head_sha}) did not test ${subject}`);
  }
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
  } else if (command === "record-run" && /^\d+$/u.test(args[0] ?? "")) {
    await recordRun(args[0]);
  } else {
    console.error("Usage: node scripts/ci-ledger.mjs key [rev] | lookup <job>... | record-run <ci-run-id>");
    process.exit(2);
  }
}
