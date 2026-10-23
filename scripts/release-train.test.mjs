import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  api,
  bumpVersion,
  checkStable,
  codeqlLanguages,
  COMPONENTS,
  inflightRef,
  intentRef,
  nextBetaVersion,
  normalizeScope,
  parseIntentRef,
  planTrain,
  stableVersion,
} from "./release-train.mjs";

const MAIN = "c".repeat(40);
const OLD = "a".repeat(40);
const NEWER = "f".repeat(40);
const BETA_COMMIT = "b".repeat(40);
const ancestry = new Map([[OLD, [MAIN]], [MAIN, [MAIN]]]);
const isAncestor = (ancestor, descendant) => ancestry.get(ancestor)?.includes(descendant) ?? false;

function train({ refs, tags = [], states = {}, stables = [] }) {
  return planTrain({
    refs,
    trainSha: MAIN,
    isAncestor,
    tagExists: (tag) => tags.includes(tag),
    productionState: (tag) => states[tag] ?? "none",
    stables,
  });
}

// What claimAndShip writes when a train takes a stable intent.
const stableInflight = (tag, id, scope, candidate = "xmatrix-v1.0.606-beta.2") =>
  inflightRef(tag, id, scope, { bump: "minor", candidate });

test("a scope is canonical, unique and keeps desktop with its cli", () => {
  assert.deepEqual(normalizeScope("web,hub"), ["hub", "web"]);
  assert.deepEqual(normalizeScope("all"), ["hub", "web", "cli", "desktop", "android", "ios"]);
  for (const bad of ["", "hub,hub", "desktop", "hub,server"]) {
    assert.throws(() => normalizeScope(bad), /desktop requires cli/u, bad);
  }
});

test("no component ships unscanned; the workflows that release it are scanned too", () => {
  for (const component of COMPONENTS) {
    const [workflows, language, ...rest] = codeqlLanguages([component]);
    assert.equal(workflows, "actions", component);
    assert.equal(typeof language, "string", component);
    assert.deepEqual(rest, [], component);
  }
});

test("a stable scope names the stable Web and clients; the hub ships with every beta", () => {
  assert.deepEqual(normalizeScope("all", "stable"), ["web", "cli", "desktop", "android", "ios"]);
  assert.deepEqual(normalizeScope("ios,web,cli", "stable"), ["web", "cli", "ios"]);
  for (const bad of ["hub", "cli,hub", "desktop", ""]) {
    assert.throws(() => normalizeScope(bad, "stable"), /the hub ships with every beta/u, bad);
  }
});

test("intent refs round-trip and reject anything else", () => {
  const open = intentRef("123", ["web", "hub"]);
  assert.equal(open, "refs/release-intents/123/hub+web");
  assert.deepEqual(parseIntentRef(open, OLD), { ref: open, sha: OLD, id: "123", scope: ["hub", "web"], state: "open" });
  const stable = intentRef("124", ["ios", "cli"], { bump: "minor", candidate: "xmatrix-v1.0.606-beta.3" });
  assert.equal(stable, "refs/release-intents/124/cli+ios/minor/xmatrix-v1.0.606-beta.3");
  assert.deepEqual(parseIntentRef(stable, BETA_COMMIT), {
    ref: stable, sha: BETA_COMMIT, id: "124", scope: ["cli", "ios"], state: "open",
    stable: { bump: "minor", candidate: "xmatrix-v1.0.606-beta.3" },
  });
  const inflight = inflightRef("xmatrix-v1.0.606-beta.3", "123", ["hub"]);
  assert.equal(inflight, "refs/release-inflight/xmatrix-v1.0.606-beta.3/123/hub");
  assert.equal(parseIntentRef(inflight, OLD).tag, "xmatrix-v1.0.606-beta.3");
  // In flight, a stable keeps its suffix, so it stays a stable before any tag exists.
  const stableFlight = inflightRef("xmatrix-v1.1.0", "124", ["cli", "ios"], { bump: "minor", candidate: "xmatrix-v1.0.606-beta.3" });
  assert.equal(stableFlight, "refs/release-inflight/xmatrix-v1.1.0/124/cli+ios/minor/xmatrix-v1.0.606-beta.3");
  assert.deepEqual(parseIntentRef(stableFlight, BETA_COMMIT), {
    ref: stableFlight, sha: BETA_COMMIT, id: "124", scope: ["cli", "ios"], tag: "xmatrix-v1.1.0", state: "inflight",
    stable: { bump: "minor", candidate: "xmatrix-v1.0.606-beta.3" },
  });
  assert.throws(() => inflightRef("xmatrix-v1.1.0-beta.1", "124", ["cli"], { bump: "minor", candidate: "xmatrix-v1.0.606-beta.3" }),
    /cannot ship as xmatrix-v1\.1\.0-beta\.1/u);
  assert.equal(parseIntentRef("refs/release-inflight/xmatrix-v1.1.0-beta.1/124/cli/minor/xmatrix-v1.0.606-beta.3", OLD), null);
  for (const bad of ["refs/release-intents/abc/hub", "refs/release-intents/1/web+hub", "refs/release-intents/1/desktop",
    "refs/release-inflight/v1/1/hub", "refs/heads/main", "refs/release-inflight/xmatrix-v1.0.6-rc.1/1/hub",
    "refs/release-intents/1/hub/minor/xmatrix-v1.0.6-beta.1", "refs/release-intents/1/cli/huge/xmatrix-v1.0.6-beta.1",
    "refs/release-intents/1/cli/patch/xmatrix-v1.0.6", "refs/release-intents/1/cli/patch"]) {
    assert.equal(parseIntentRef(bad, OLD), null, bad);
  }
  assert.throws(() => intentRef("1", ["cli"], { bump: "patch", candidate: "xmatrix-v1.0.6" }), /verified beta tag/u);
});

test("a train ships the union of every open beta its revision contains, never a stable with them", () => {
  const result = train({ refs: [
    { ref: "refs/release-intents/20/web", sha: OLD },
    { ref: "refs/release-intents/10/hub", sha: MAIN },
    { ref: "refs/release-intents/30/cli+desktop", sha: NEWER },
    { ref: "refs/release-intents/40/cli/patch/xmatrix-v1.0.606-beta.2", sha: BETA_COMMIT },
    { ref: "refs/release-intents/25/android/minor/xmatrix-v1.0.606-beta.1", sha: BETA_COMMIT },
  ] });
  assert.deepEqual(result.eligible.map((intent) => intent.id), ["10", "20"]);
  assert.deepEqual(result.scope, ["hub", "web"], "an intent from after the freeze waits for the next train");
  assert.deepEqual(result.stable.map((intent) => intent.id), ["25", "40"], "stables are offered oldest first, apart");
  assert.deepEqual(result.updates, []);
});

test("in-flight betas close on success, wait while deploying and reopen on failure", () => {
  const refs = [
    { ref: "refs/release-inflight/xmatrix-v0.16.1/1/hub", sha: OLD },
    { ref: "refs/release-inflight/xmatrix-v0.16.2/2/web", sha: OLD },
    { ref: "refs/release-inflight/xmatrix-v0.16.3/3/cli", sha: OLD },
    { ref: "refs/release-inflight/xmatrix-v0.16.4-beta.1/4/android", sha: OLD },
  ];
  const result = train({
    refs,
    tags: ["xmatrix-v0.16.1", "xmatrix-v0.16.2", "xmatrix-v0.16.3"],
    states: { "xmatrix-v0.16.1": "success", "xmatrix-v0.16.2": "active", "xmatrix-v0.16.3": "failed" },
  });
  assert.deepEqual(result.updates, [
    { delete: "refs/release-inflight/xmatrix-v0.16.1/1/hub" },
    { delete: "refs/release-inflight/xmatrix-v0.16.3/3/cli" },
    { create: "refs/release-intents/3/cli", sha: OLD },
    { delete: "refs/release-inflight/xmatrix-v0.16.4-beta.1/4/android" },
    { create: "refs/release-intents/4/android", sha: OLD },
  ]);
  assert.deepEqual(result.scope, ["cli", "android"], "a failed or never-tagged train's intents ride the next one");
});

test("a stable is never retried by a new train: untagged closes, a failed run waits for its own recovery", () => {
  const untagged = stableInflight("xmatrix-v1.1.0", "7", ["cli", "android"]);
  const failed = stableInflight("xmatrix-v1.2.0", "8", ["cli", "android", "ios"]);
  const result = train({
    refs: [{ ref: untagged, sha: BETA_COMMIT }, { ref: failed, sha: BETA_COMMIT }],
    tags: ["xmatrix-v1.2.0"],
    states: { "xmatrix-v1.2.0": "failed" },
  });
  assert.deepEqual(result.updates, [{ delete: untagged }], "nothing changed before the tag, so the decision ends");
  assert.deepEqual(result.pending.map((intent) => intent.ref), [failed]);
  assert.deepEqual(result.eligible, []);
  assert.deepEqual(result.stable, []);
});

test("a failed stable closes only when a later successful stable shipped every component it names", () => {
  const failed = stableInflight("xmatrix-v1.2.0", "8", ["cli", "android"]);
  const refs = [{ ref: failed, sha: BETA_COMMIT }];
  const base = { refs, tags: ["xmatrix-v1.2.0"], states: { "xmatrix-v1.2.0": "failed" } };
  const partial = train({ ...base, stables: [{ tag: "xmatrix-v1.3.0", scope: ["cli"] }] });
  assert.deepEqual(partial.pending.map((intent) => intent.ref), [failed], "a CLI-only stable leaves Android pending");
  const older = train({ ...base, stables: [{ tag: "xmatrix-v1.1.0", scope: ["cli", "android"] }] });
  assert.deepEqual(older.pending.map((intent) => intent.ref), [failed], "only a later stable can cover it");
  const covered = train({ ...base, stables: [{ tag: "xmatrix-v1.3.0", scope: ["cli", "desktop", "android"] }] });
  assert.deepEqual(covered.updates, [{ delete: failed }]);
  assert.deepEqual(covered.pending, []);
});

test("an in-flight ref without the stable suffix reconciles like a beta, even under a stable-form tag", () => {
  const legacy = "refs/release-inflight/xmatrix-v1.0.606/9/web";
  const result = train({ refs: [{ ref: legacy, sha: OLD }], tags: ["xmatrix-v1.0.606"],
    states: { "xmatrix-v1.0.606": "failed" } });
  assert.deepEqual(result.updates, [{ delete: legacy }, { create: "refs/release-intents/9/web", sha: OLD }]);
});

test("a half-finished move keeps the in-flight copy only", () => {
  const result = train({ refs: [
    { ref: "refs/release-intents/5/hub", sha: OLD },
    { ref: "refs/release-inflight/xmatrix-v0.16.9/5/hub", sha: OLD },
  ], tags: ["xmatrix-v0.16.9"], states: { "xmatrix-v0.16.9": "active" } });
  assert.deepEqual(result.updates, [{ delete: "refs/release-intents/5/hub" }]);
  assert.deepEqual(result.eligible, []);
});

test("a beta precedes the patch after the last stable unless main or an earlier beta plans higher", () => {
  assert.equal(nextBetaVersion({ tagNames: ["xmatrix-v1.0.605", "cli-v1.0.2"], mainVersion: "1.0.0" }), "1.0.606-beta.1");
  assert.equal(nextBetaVersion({
    tagNames: ["xmatrix-v1.0.605", "xmatrix-v1.0.606-beta.9", "xmatrix-v1.0.606-beta.10"], mainVersion: "1.0.0",
  }), "1.0.606-beta.11", "betas count numerically");
  assert.equal(nextBetaVersion({ tagNames: ["xmatrix-v1.0.605", "xmatrix-v1.0.606-beta.4", "xmatrix-v1.0.606"],
    mainVersion: "1.0.0" }), "1.0.607-beta.1", "a stable closes its betas");
  assert.equal(nextBetaVersion({ tagNames: ["xmatrix-v1.0.605"], mainVersion: "2.0.0" }), "2.0.0-beta.1");
  assert.equal(nextBetaVersion({ tagNames: ["xmatrix-v1.0.605", "xmatrix-v2.0.0-beta.2"], mainVersion: "1.0.0" }),
    "2.0.0-beta.3");
  assert.equal(nextBetaVersion({ tagNames: [], mainVersion: undefined }), "0.0.1-beta.1");
});

test("a stable is the last stable raised by the chosen bump, reaching its beta and above every release", () => {
  assert.equal(bumpVersion("1.0.605", "patch"), "1.0.606");
  assert.equal(bumpVersion("1.9.605", "minor"), "1.10.0");
  assert.equal(bumpVersion("1.9.605", "major"), "2.0.0");
  const tagNames = ["xmatrix-v1.0.605", "xmatrix-v1.0.606-beta.3", "xmatrix-v1.0.606-beta.7"];
  assert.equal(stableVersion({ tagNames, candidate: "xmatrix-v1.0.606-beta.3", bump: "patch" }), "1.0.606");
  assert.equal(stableVersion({ tagNames, candidate: "xmatrix-v1.0.606-beta.3", bump: "minor" }), "1.1.0");
  assert.equal(stableVersion({ tagNames, candidate: "xmatrix-v1.0.606-beta.3", bump: "major" }), "2.0.0");
  const planned = ["xmatrix-v1.0.605", "xmatrix-v1.1.0-beta.2"];
  assert.throws(() => stableVersion({ tagNames: planned, candidate: "xmatrix-v1.1.0-beta.2", bump: "patch" }),
    /does not reach xmatrix-v1\.1\.0-beta\.2; choose a larger bump/u);
  assert.equal(stableVersion({ tagNames: planned, candidate: "xmatrix-v1.1.0-beta.2", bump: "minor" }), "1.1.0");
  const moved = ["xmatrix-v1.0.605", "xmatrix-v1.0.606", "xmatrix-v1.1.0-beta.1", "xmatrix-v1.0.606-beta.4"];
  assert.throws(() => stableVersion({ tagNames: moved, candidate: "xmatrix-v1.0.606-beta.4", bump: "patch" }),
    /must be newer than every release, and 1\.1\.0-beta\.1 exists/u);
});

test("planner GitHub reads retry network failures and 5xx, not client errors", async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers["cache-control"], "no-cache");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      if (calls === 2) return new Response("", { status: 502 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    assert.deepEqual(await api("/x", "token", { delayMs: 1 }), { ok: true });
    assert.equal(calls, 3);

    calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response("", { status: 404 }); };
    await assert.rejects(api("/x", "token", { delayMs: 1 }), /GitHub \/x: 404/);
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new TypeError("fetch failed"); };
    await assert.rejects(api("/x", "token", { attempts: 3, delayMs: 1 }), /GitHub \/x: fetch failed/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// checkStable reads real tags, release commits and ancestry, so it runs on a
// repository shaped like the release history: main revisions, each release a
// stamped child commit, tagged with the facts its train records.
function releaseRepository() {
  const directory = mkdtempSync(path.join(tmpdir(), "xmatrix-release-train-"));
  const origin = path.join(directory, "origin.git");
  const root = path.join(directory, "work");
  const run = (args, cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  execFileSync("git", ["init", "--quiet", "-b", "main", root]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "test@example.com"]);
  run(["remote", "add", "origin", origin]);
  const commitMain = (label) => {
    writeFileSync(path.join(root, "version.json"), `${JSON.stringify({ version: "1.0.0" }, null, 2)}\n`);
    writeFileSync(path.join(root, "work.txt"), `${label}\n`);
    run(["add", "."]);
    run(["commit", "--quiet", "-m", label]);
    return run(["rev-parse", "HEAD"]);
  };
  const release = (source, version, fields) => {
    run(["checkout", "--quiet", "--detach", source]);
    writeFileSync(path.join(root, "version.json"), `${JSON.stringify({ version }, null, 2)}\n`);
    run(["commit", "--quiet", "--all", "-m", `Release ${version}`]);
    const commit = run(["rev-parse", "HEAD"]);
    const message = [`xMatrix production xmatrix-v${version}`, "", ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`)];
    run(["tag", "--annotate", "--message", message.join("\n"), `xmatrix-v${version}`, commit]);
    run(["push", "--quiet", "origin", `refs/tags/xmatrix-v${version}`]);
    run(["checkout", "--quiet", "main"]);
    return commit;
  };
  return { directory, root, commitMain, release, push: () => run(["push", "--quiet", "origin", "main"]) };
}

test("the train distinguishes unavailable production evidence from a failed candidate", async (t) => {
  const successful = { id: 20, status: "completed", conclusion: "success" };
  const cases = [
    { name: "missing then visible", responses: [[], [successful]], ships: true, reads: 2 },
    { name: "still missing", responses: [[]], reads: 120 },
    { name: "evidence deadline", responses: [[]], advanceMs: 600_000, reads: 1 },
    { name: "still active", responses: [[{ ...successful, status: "in_progress", conclusion: null }]], reads: 1 },
    { name: "API denied", responses: [403], reads: 1 },
    { name: "API unavailable", responses: [502], reads: 5 },
    { name: "latest run failed", responses: [[successful, { id: 21, status: "completed", conclusion: "failure" }]],
      invalid: true, reads: 1 },
  ];
  for (const scenario of cases) await t.test(scenario.name, () => {
    const repo = releaseRepository();
    t.after(() => rmSync(repo.directory, { recursive: true, force: true }));
    mkdirSync(path.join(repo.root, "docs/releases"), { recursive: true });
    writeFileSync(path.join(repo.root, "docs/releases/1.0.1.md"), "# xMatrix 1.0.1\n\nUser-facing fixes.\n");
    const source = repo.commitMain("candidate");
    const candidate = "xmatrix-v1.0.1-beta.1";
    const beta = repo.release(source, "1.0.1-beta.1", { scope: "hub,web", source, channel: "beta" });
    repo.push();
    const stableRef = intentRef("77", ["web"], { candidate, bump: "patch" });
    const betaRef = intentRef("88", ["hub"]);
    const git = (...args) => execFileSync("git", args, { cwd: repo.root, encoding: "utf8", stdio: "pipe" }).trim();
    git("push", "origin", `${beta}:${stableRef}`, `${source}:${betaRef}`);
    const preload = path.join(repo.directory, "github.mjs");
    const callsFile = path.join(repo.directory, "reads.json");
    // Only the HTTP transport and clock are replaced; the real CLI reconciles
    // actual remote refs, verifies tags/notes/ancestry and claims the version.
    writeFileSync(preload, `
      import { writeFileSync } from "node:fs";
      const responses = ${JSON.stringify(scenario.responses)};
      let reads = 0;
      const now = Date.now;
      let elapsed = 0;
      Date.now = () => now() + elapsed;
      globalThis.setTimeout = (callback) => { elapsed += ${scenario.advanceMs ?? 0}; queueMicrotask(callback); };
      globalThis.fetch = async () => {
        const reply = responses[Math.min(reads++, responses.length - 1)];
        return typeof reply === "number"
          ? new Response("", { status: reply })
          : new Response(JSON.stringify({ workflow_runs: reply }));
      };
      process.on("exit", () => writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(reads)));
    `);
    const result = spawnSync(process.execPath,
      ["--import", preload, fileURLToPath(new URL("./release-train.mjs", import.meta.url)), "plan"], {
        cwd: repo.root, encoding: "utf8", timeout: 15_000,
        env: { ...process.env, GITHUB_REPOSITORY: "test/repo", GITHUB_TOKEN: "test-token",
          GITHUB_SHA: source, GITHUB_RUN_ID: "1234", GITHUB_OUTPUT: "" },
      });
    assert.equal(result.status, scenario.ships || scenario.invalid ? 0 : 1, result.stderr + result.stdout);
    const refs = git("ls-remote", "origin", "refs/release-intents/*", "refs/release-inflight/*");
    assert.equal(refs.includes(betaRef), !scenario.invalid, "only a definitive refusal may fall through to a beta");
    assert.equal(refs.includes(stableRef), !scenario.ships && !scenario.invalid,
      "unavailable evidence cannot delete the stable decision");
    assert.equal(refs.includes("refs/release-inflight/xmatrix-v1.0.1/77/web/patch/" + candidate), Boolean(scenario.ships));
    assert.equal(JSON.parse(readFileSync(callsFile, "utf8")), scenario.reads);
  });
});

test("a stable ships only a delivered beta that covers its clients and moves no stable source back", async (t) => {
  const repo = releaseRepository();
  t.after(() => rmSync(repo.directory, { recursive: true, force: true }));
  const first = repo.commitMain("first");
  repo.release(first, "1.0.605", {});
  mkdirSync(path.join(repo.root, "docs/releases"), { recursive: true });
  writeFileSync(path.join(repo.root, "docs/releases/1.1.0.md"), "# xMatrix 1.1.0\n\nNew user-facing features.\n");
  const second = repo.commitMain("second");
  const oldBeta = repo.release(first, "1.0.606-beta.1", { scope: "hub,web,cli", source: first });
  const beta = repo.release(second, "1.0.606-beta.2", { scope: "hub,web,cli,android", source: second });
  repo.push();
  const tagNames = ["xmatrix-v1.0.605", "xmatrix-v1.0.606-beta.1", "xmatrix-v1.0.606-beta.2"];
  const states = { "xmatrix-v1.0.606-beta.1": "success", "xmatrix-v1.0.606-beta.2": "success" };
  const context = { tagNames, mainSha: second, productionState: async (tag) => states[tag] ?? "none" };
  const check = (intent) => checkStable(repo.root, { bump: "minor", scope: ["cli"], ...intent }, context);

  assert.deepEqual(await check({ candidate: "xmatrix-v1.0.606-beta.2", sha: beta }),
    { version: "1.1.0", tag: "xmatrix-v1.1.0", sourceSha: second, commit: beta });
  // Newer main's notes cannot authorize a candidate cut before they existed.
  await assert.rejects(check({ candidate: "xmatrix-v1.0.606-beta.1" }), /Missing release notes/u);
  await assert.rejects(check({ candidate: "xmatrix-v1.0.606-beta.2", scope: ["cli", "ios"] }),
    /did not ship ios; verify a beta that did/u);
  await assert.rejects(check({ candidate: "xmatrix-v1.0.606-beta.2", sha: oldBeta }), /no longer points at/u);
  states["xmatrix-v1.0.606-beta.2"] = "failed";
  await assert.rejects(check({ candidate: "xmatrix-v1.0.606-beta.2" }), /Production Release is failed, not success/u);
  await assert.rejects(check({ candidate: "xmatrix-v1.0.605" }), /not a published beta tag/u);

  // Once 1.1.0 shipped from the second revision, the older beta can never become a newer stable.
  repo.release(second, "1.1.0", { scope: "cli", source: second, channel: "stable" });
  await assert.rejects(checkStable(repo.root, { candidate: "xmatrix-v1.0.606-beta.1", bump: "major", scope: ["cli"] },
    { ...context, tagNames: [...tagNames, "xmatrix-v1.1.0"] }), /does not contain .*the source of stable 1\.1\.0; a stable never moves back/u);
});
