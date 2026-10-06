import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  HUB_SUITE_LEDGER_JOB,
  LEDGER_JOBS,
  RECORDED_WORKFLOWS,
  ledgerJobOf,
  ledgerKey,
  ledgerRef,
  passedLedgerJobs,
  remoteCommits,
  subjectMatchesRun,
  unzipSingleFile,
} from "./ci-ledger.mjs";

const tree = (entries) => entries.map(([blob, file]) => `100644 blob ${blob}\t${file}`).join("\0") + "\0";

test("a version-only bump keeps the key; any other change moves it", () => {
  const listing = tree([["aaa", "version.json"], ["bbb", "packages/hub/src/a.ts"]]);
  const before = ledgerKey(listing, { "version.json": '{ "version": "0.16.340" }\n' }, "0.16.340");
  // The bumped file has a new blob id, which the key must not see.
  const bumped = ledgerKey(tree([["ccc", "version.json"], ["bbb", "packages/hub/src/a.ts"]]),
    { "version.json": '{ "version": "0.16.341" }\n' }, "0.16.341");
  assert.equal(bumped, before);
  const edited = ledgerKey(tree([["aaa", "version.json"], ["ddd", "packages/hub/src/a.ts"]]),
    { "version.json": '{ "version": "0.16.340" }\n' }, "0.16.340");
  assert.notEqual(edited, before);
  // A versioned file changing anything besides the version is a real change.
  const reshaped = ledgerKey(listing, { "version.json": '{ "version": "0.16.340", "x": 1 }\n' }, "0.16.340");
  assert.notEqual(reshaped, before);
  // Renames and mode changes are content too.
  assert.notEqual(ledgerKey(tree([["aaa", "version.json"], ["bbb", "packages/hub/src/b.ts"]]),
    { "version.json": '{ "version": "0.16.340" }\n' }, "0.16.340"), before);
});

test("a dependency sharing the release version does not break a version-only bump", () => {
  const lock = (own) =>
    `[[package]]\nname = "anstream"\nversion = "1.0.0"\n\n[[package]]\nname = "xmatrix"\nversion = "${own}"\n`;
  const listing = tree([["aaa", "version.json"], ["bbb", "packages/cli-rs/Cargo.lock"]]);
  const key = (own, lockText = lock(own)) => ledgerKey(listing, {
    "version.json": `{\n  "version": "${own}"\n}\n`,
    "packages/cli-rs/Cargo.lock": lockText,
  });
  assert.equal(key("1.0.1"), key("1.0.0"));
  // Changing the dependency's version is still a real change.
  assert.notEqual(key("1.0.0", lock("1.0.0").replace('"anstream"\nversion = "1.0.0"', '"anstream"\nversion = "1.0.1"')),
    key("1.0.0"));
});

test("a run vouches only for the commit it could have tested", () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const merge = "c".repeat(40);
  assert.ok(subjectMatchesRun({ event: "push", head_sha: head }, head, [base]));
  assert.ok(!subjectMatchesRun({ event: "push", head_sha: head }, merge, [base, head]));
  assert.ok(subjectMatchesRun({ event: "pull_request", head_sha: head }, merge, [base, head]));
  assert.ok(!subjectMatchesRun({ event: "pull_request", head_sha: head }, merge, [head, base]));
  assert.ok(!subjectMatchesRun({ event: "pull_request", head_sha: head }, "not-a-sha", [base, head]));
  assert.ok(!subjectMatchesRun({ event: "workflow_dispatch", head_sha: head }, head, [base]));
});

test("artifact zips are read whether stored or deflated", () => {
  const body = Buffer.from('{"sha":"' + "c".repeat(40) + '"}\n');
  for (const [method, data] of [[0, body], [8, deflateRawSync(body)]]) {
    const name = Buffer.from("ci-ledger-subject.json");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const centralOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    const zip = Buffer.concat([local, name, data, central, name, eocd]);
    assert.deepEqual(unzipSingleFile(zip), body);
  }
});

test("ledger refs are confined to their namespace", () => {
  assert.equal(ledgerRef("hub", "k"), "refs/ci-ledger/hub/k");
  assert.throws(() => ledgerRef("../heads/main", "k"));
});

test("every ledgered job gates on its lookup and CI never holds a write token", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const job of LEDGER_JOBS) {
    // The Hub suite's ledger entry belongs to the sharded `hub` matrix job.
    const start = ci.indexOf(`\n  ${job === HUB_SUITE_LEDGER_JOB ? "hub" : job}:\n`);
    assert.ok(start >= 0, job);
    const next = ci.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u);
    const block = ci.slice(start, next < 0 ? undefined : start + 1 + next);
    assert.ok(block.includes(`run: node scripts/ci-ledger.mjs lookup ${job}\n`), job);
    const steps = block.split("\n      - ").slice(1);
    const lookup = steps.findIndex((step) => step.includes("ci-ledger.mjs lookup"));
    // Every step after the lookup that runs a check is skipped on a hit.
    for (const step of steps.slice(lookup + 1)) {
      if (/\n        run: /u.test(step) || step.startsWith("name:")) {
        assert.match(step, /if: (?:\$\{\{ .*)?steps\.ledger\.outputs\.hit != 'true'/u, `${job}: ${step.split("\n")[0]}`);
      }
    }
  }
  assert.doesNotMatch(ci, /(?:actions|contents|pull-requests): write/u);
  assert.match(ci, /name: ci-ledger-subject/u);
});

test("a selector-gated ledgered job is never scheduled for content that already passed it", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const changes = ci.slice(ci.indexOf("\n  changes:\n"), ci.indexOf("\n  node-checks:\n"));
  for (const job of LEDGER_JOBS) {
    // The shared Node gate starts before the selector and looks itself up.
    if (job === "node-checks") continue;
    const name = job === HUB_SUITE_LEDGER_JOB ? "hub" : job;
    const start = ci.indexOf(`\n  ${name}:\n`);
    const next = ci.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u);
    const block = ci.slice(start, next < 0 ? undefined : start + 1 + next);
    assert.match(block, /^    needs: changes$/mu, job);
    assert.ok(block.includes(`&& !contains(needs.changes.outputs.reused, ' ${job} ')`), job);
    assert.ok(changes.includes(`jobs+=(`) && new RegExp(`jobs\\+=\\([^)]*\\b${job}\\b`, "u").test(changes), `selector looks up ${job}`);
  }
  assert.ok(changes.includes("node scripts/ci-ledger.mjs reused"));
});

test("the recorder runs for every workflow whose runs it accepts", () => {
  const recorder = readFileSync(new URL("../.github/workflows/ci-ledger.yml", import.meta.url), "utf8");
  const names = [...RECORDED_WORKFLOWS].map((file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8").match(/^name: (.+)$/mu)[1]);
  assert.deepEqual(names, ["CI", "Public Snapshot CI"]);
  assert.match(recorder, new RegExp(`workflows: \\[${names.join(", ")}\\]`, "u"));
  assert.match(recorder, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/u);
  assert.match(recorder, /run: node scripts\/ci-ledger\.mjs record-run "\$RUN_ID"/u);
});

test("one ls-remote reports exactly the recorded refs among many", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xmatrix-ledger-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "--quiet", "--bare", origin);
  git(root, "init", "--quiet", work);
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "subject");
  const subject = git(work, "rev-parse", "HEAD");
  git(work, "remote", "add", "origin", origin);
  const key = "a".repeat(40);
  git(work, "push", "--quiet", "origin", `${subject}:${ledgerRef("hub", key)}`, `${subject}:${ledgerRef("web", "b".repeat(40))}`);

  const refs = ["hub", "hub-2", "web"].map((job) => ledgerRef(job, key));
  const commits = remoteCommits(refs, { cwd: work });
  assert.deepEqual([...commits], [[ledgerRef("hub", key), subject]]);
});

test("the Hub suite is recorded only from a run that passed all of it", () => {
  const job = (name, conclusion = "success") => ({ name, conclusion });
  assert.deepEqual(passedLedgerJobs([job("hub"), job("web")]).sort(), ["web", HUB_SUITE_LEDGER_JOB].sort());
  assert.deepEqual(passedLedgerJobs([job("hub", "failure")]), []);
  // A run from the retired two-shard layout proves the suite only when both shards passed.
  assert.deepEqual(passedLedgerJobs([job("hub"), job("hub-2")]), [HUB_SUITE_LEDGER_JOB]);
  assert.deepEqual(passedLedgerJobs([job("hub"), job("hub-2", "failure")]), []);
  assert.deepEqual(passedLedgerJobs([job("hub"), job("hub-2", "cancelled")]), []);
  assert.deepEqual(passedLedgerJobs([job(HUB_SUITE_LEDGER_JOB)]), [], "no job can claim the suite by name");
});

test("a job split over a matrix is recorded only when every entry passed", () => {
  const job = (name, conclusion = "success") => ({ name, conclusion });
  const hub = ["hub (static)", ...[1, 2, 3, 4, 5, 6].map((shard) => `hub (${shard}/6)`)];
  const web = ["web", ...[1, 2, 3, 4].map((shard) => `web (browser ${shard}/4)`)];
  const rust = ["rust-cli (clippy)", "rust-cli (test)"];
  assert.deepEqual(
    passedLedgerJobs([...hub, ...web, ...rust, "rust-cli-windows"].map((name) => job(name))).sort(),
    [HUB_SUITE_LEDGER_JOB, "rust-cli", "rust-cli-windows", "web"].sort(),
  );
  assert.deepEqual(passedLedgerJobs([...hub.slice(0, 6).map((name) => job(name)), job("hub (6/6)", "failure")]), []);
  assert.deepEqual(passedLedgerJobs([job("web"), job("web (browser 2/4)", "cancelled")]), []);
  assert.deepEqual(passedLedgerJobs([job("rust-cli (clippy)"), job("rust-cli (test)", "skipped")]), []);
  assert.equal(ledgerJobOf("rust-cli-windows"), "rust-cli-windows");
  assert.equal(ledgerJobOf("hub (static)"), HUB_SUITE_LEDGER_JOB);
  // The current hosted layout: the primary web shard also runs the unit tests.
  assert.deepEqual(
    passedLedgerJobs([1, 2, 3, 4].map((shard) => job(`web (${shard}/4)`))),
    ["web"],
  );
  assert.deepEqual(passedLedgerJobs([job("web (1/4)"), job("web (3/4)", "failure")]), []);
  // The public snapshot calls CI as its `validate` job.
  assert.equal(ledgerJobOf("validate / web (browser 1/4)"), "web");
  assert.equal(ledgerJobOf("validate / hub (3/6)"), HUB_SUITE_LEDGER_JOB);
  assert.deepEqual(
    passedLedgerJobs(["rust-cli (clippy)", "rust-cli (test)"].map((name) => job(`validate / ${name}`))),
    ["rust-cli"],
  );
});

test("a retired single-shard hub record never satisfies a Hub suite lookup", () => {
  // Before 2026-09-27 refs/ci-ledger/hub/<key> meant only the first shard passed.
  assert.notEqual(ledgerRef(HUB_SUITE_LEDGER_JOB, "k"), ledgerRef("hub", "k"));
  assert.equal(LEDGER_JOBS.has("hub"), false);
  assert.equal(LEDGER_JOBS.has("hub-2"), false);
});
