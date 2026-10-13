import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const awaitedRequest = await readFile(new URL("../.github/workflows/production-release-request.yml", import.meta.url), "utf8");
const production = await readFile(new URL("../.github/workflows/production-release.yml", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = "a".repeat(40);

function scriptFrom(workflow, stepName) {
  const step = Object.values(parse(workflow).jobs).flatMap(job => job?.steps ?? [])
    .find(step => step.name === stepName);
  assert.equal(typeof step?.with?.script, "string", `Missing workflow script ${stepName}`);
  return new AsyncFunction("github", "context", "core", "process", "require", "setTimeout", step.with.script);
}

const intent = await readFile(new URL("../.github/workflows/production-release-intent.yml", import.meta.url), "utf8");
const record = scriptFrom(intent, "Record the intent and wake the train");
const authorize = scriptFrom(production, "Require successful exact-SHA selected request evidence");
const server = await readFile(new URL("../.github/workflows/server-release.yml", import.meta.url), "utf8");
const hub = scriptFrom(server, "Reverify exact selected request before reusing its test result");
const web = scriptFrom(server, "Reverify exact selected request before reusing the Web test result");

async function runIntent(releaseComponents) {
  const failures = [];
  const created = [];
  const dispatched = [];
  const summary = { addHeading: () => summary, addRaw: () => summary, write: async () => {} };
  const github = {
    rest: {
      git: { createRef: async (input) => { created.push(input.ref); } },
      actions: { createWorkflowDispatch: async (input) => { dispatched.push(input.workflow_id); } },
    },
  };
  await record(github, {
    ref: "refs/heads/main", payload: { repository: { default_branch: "main" } }, sha, runId: 77, repo: {},
  }, { setFailed: (message) => failures.push(message), notice: () => {}, summary },
  { env: { RELEASE_COMPONENTS: releaseComponents, RELEASE_TOKEN: "token" } });
  return { failures, created, dispatched };
}

test("intent scope is canonical, nonempty, and preserves the Desktop CLI dependency", async () => {
  assert.deepEqual((await runIntent("web,hub")).created, ["refs/release-intents/77/hub+web"]);
  assert.deepEqual((await runIntent("web,hub")).dispatched, ["production-release-request.yml"]);
  assert.deepEqual((await runIntent("all")).created, ["refs/release-intents/77/hub+web+cli+desktop+android+ios"]);
  for (const invalid of ["", "web,web", "unknown", "web,unknown", "desktop", "cli,desktop,cli", " web"]) {
    const result = await runIntent(invalid);
    assert.deepEqual(result.created, [], invalid);
    assert.deepEqual(result.dispatched, [], invalid);
    assert.equal(result.failures.length, 1, invalid);
  }
});

// Stands in for scripts/release-commit.mjs: the deploy SHA is authorized when it
// is the request's SHA or a known release commit of it.
const releaseCommits = new Map([["c".repeat(40), sha]]);
const fakeRequire = (name) => {
  assert.equal(name, "child_process");
  return {
    execFileSync: (command, [script, verb, deploySha, sourceSha]) => {
      assert.deepEqual([command, script, verb], ["node", "scripts/release-commit.mjs", "verify"]);
      if (deploySha !== sourceSha && releaseCommits.get(deploySha) !== sourceSha) {
        throw new Error("not a release commit");
      }
    },
  };
};

async function runAuthorization({ scope = "web", overrides = {}, authorityScope = scope, authorityConclusion = "success",
  authorityStatus = "completed", authorityCount = 1, requestSha = sha, deploySha = sha, lagging = 0, reader = authorize } = {}) {
  const failures = [];
  // The request's own `gates` job stands for every gate its scope selected;
  // ci.yml's job names (`ci / hub (1/6)`, ...) are not part of the evidence.
  const jobs = ["plan", "ci / changes", "ci / hub (1/6)", "ci / web", "gates"]
    .map((name) => ({ name, conclusion: overrides[name] ?? "success" }));
  const authority = { name: `authorize ${authorityScope} production`, status: authorityStatus, conclusion: authorityConclusion, steps: [] };
  jobs.push(...Array.from({ length: authorityCount }, () => authority));
  jobs.push({ name: "authorize-and-dispatch", status: "completed", conclusion: "success", steps: [] });
  let reads = 0;
  const listRuns = () => {};
  const listJobs = () => {};
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: listRuns,
        listJobsForWorkflowRun: listJobs,
        getWorkflowRun: async ({ run_id }) => ({ data: run_id === 456 ? {
          path: ".github/workflows/production-release.yml", event: "workflow_dispatch", head_sha: deploySha,
        } : {
          id: 123, path: ".github/workflows/production-release-request.yml",
          event: "workflow_dispatch", head_branch: "main", head_sha: requestSha,
        } }),
      },
    },
    // The first `lagging` reads lack the authorization job conclusion;
    // no step metadata is available even after every job completes.
    paginate: async (method) => {
      if (method === listRuns) return [{ id: 456, head_sha: deploySha }];
      reads += 1;
      return reads > lagging ? jobs : jobs.map((job) => job === authority
        ? { ...job, status: "in_progress", conclusion: null } : job);
    },
  };
  await reader(github, {
    repo: { owner: "LambdaLabsHQ", repo: "xmatrix" }, ref: "refs/tags/xmatrix-v0.16.339", runId: 456,
  }, { setFailed: (message) => failures.push(message) }, {
    env: { DEPLOY_SHA: deploySha, REQUEST_RUN_ID: "123", RELEASE_SCOPE: scope },
  }, fakeRequire, (resolve) => { resolve(); });
  return failures;
}

test("tagged preflight accepts only the tested exact scope and its passed gates", async () => {
  assert.deepEqual(await runAuthorization(), []);
  assert.deepEqual(await runAuthorization({ scope: "hub,web,cli,desktop,android,ios" }), []);
  assert.notDeepEqual(await runAuthorization({ scope: "hub", authorityScope: "web" }), []);
  for (const job of ["plan", "gates"]) {
    for (const conclusion of ["failure", "skipped", "cancelled"]) {
      assert.notDeepEqual(await runAuthorization({ overrides: { [job]: conclusion } }), [], `${job} ${conclusion}`);
    }
  }
  assert.notDeepEqual(await runAuthorization({ scope: "web,hub" }), []);
  assert.notDeepEqual(await runAuthorization({ scope: "desktop" }), []);
  assert.notDeepEqual(await runAuthorization({ authorityScope: "hub" }), []);
  assert.notDeepEqual(await runAuthorization({ requestSha: "b".repeat(40) }), []);
  // The request's release commit (its SHA plus the stamped version) is the same authorization.
  assert.deepEqual(await runAuthorization({ deploySha: "c".repeat(40) }), []);
  assert.notDeepEqual(await runAuthorization({ deploySha: "c".repeat(40), requestSha: "b".repeat(40) }), []);
});

test("tagged preflight re-reads exact authorization whose conclusion is not yet reported", async () => {
  assert.deepEqual(await runAuthorization({ lagging: 1 }), []);
});


test("exact-scope job authorization works without steps and never accepts failed, missing or ambiguous evidence", async () => {
  for (const [reader, scope] of [[authorize, "web"], [hub, "hub"], [web, "web"]]) {
    assert.deepEqual(await runAuthorization({ reader, scope }), []);
    for (const override of [
      { authorityCount: 0 }, { authorityCount: 2 }, { authorityScope: "hub,web" },
      { authorityConclusion: "failure" }, { authorityConclusion: "cancelled" },
      { authorityConclusion: "skipped" }, { authorityStatus: "in_progress" },
      { requestSha: "b".repeat(40) }, { overrides: { gates: "failure" } },
    ]) assert.notDeepEqual(await runAuthorization({ reader, scope, ...override }), [], JSON.stringify(override));
  }
});


test("scope authority is a passed-gates job that the dispatcher must await", () => {
  const jobs = parse(awaitedRequest).jobs;
  assert.equal(jobs.authorization.name, "authorize ${{ needs.plan.outputs.scope }} production");
  assert.deepEqual(jobs.authorization.needs, ["plan", "gates"]);
  assert.ok(jobs["authorize-and-dispatch"].needs.includes("authorization"));
  for (const [job, prerequisites] of [[jobs.authorization, ["plan", "gates"]],
    [jobs["authorize-and-dispatch"], ["plan", "gates", "authorization"]]]) {
    const permits = new Function("needs", "always", `return (${job.if});`);
    const passed = Object.fromEntries(prerequisites.map(name => [name, { result: "success" }]));
    assert.equal(permits(passed, () => true), true);
    for (const name of prerequisites) for (const result of ["failure", "skipped", "cancelled"])
      assert.equal(permits({ ...passed, [name]: { result } }, () => true), false, `${name} ${result}`);
  }
});
