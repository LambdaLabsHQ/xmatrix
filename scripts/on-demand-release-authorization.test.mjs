import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const production = await readFile(new URL("../.github/workflows/production-release.yml", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = "a".repeat(40);

function scriptFrom(workflow, stepName, nextJob) {
  const step = workflow.indexOf(`name: ${stepName}`);
  assert.notEqual(step, -1);
  const start = workflow.indexOf("          script: |\n", step);
  // A script ends at the next step of its job, or at the next job.
  const ends = [workflow.indexOf("\n      - ", start), workflow.indexOf(`\n  ${nextJob}:`, start)]
    .filter((index) => index > start);
  const end = Math.min(...ends);
  assert.ok(start > step && end > start);
  const body = workflow.slice(start + "          script: |\n".length, end)
    .split("\n")
    .map((line) => line.startsWith("            ") ? line.slice(12) : line)
    .join("\n");
  return new AsyncFunction("github", "context", "core", "process", "require", body);
}

const intent = await readFile(new URL("../.github/workflows/production-release-intent.yml", import.meta.url), "utf8");
const record = scriptFrom(`${intent}\n  end:`, "Record the intent and wake the train", "end");
const authorize = scriptFrom(production, "Require successful exact-SHA selected request evidence", "verify-production-postgres");

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

async function runAuthorization({ scope = "web", overrides = {}, marker = `Record successful ${scope} production authorization`, requestSha = sha, deploySha = sha, lagging = 0 } = {}) {
  const failures = [];
  // The request's own `gates` job stands for every gate its scope selected;
  // ci.yml's job names (`ci / hub (1/6)`, ...) are not part of the evidence.
  const jobs = ["plan", "ci / changes", "ci / hub (1/6)", "ci / web", "gates"]
    .map((name) => ({ name, conclusion: overrides[name] ?? "success" }));
  const dispatcher = { name: "authorize-and-dispatch", status: "completed", steps: [{ name: marker, conclusion: "success" }] };
  jobs.push(dispatcher);
  let reads = 0;
  const listRuns = () => {};
  const listJobs = () => {};
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: listRuns,
        listJobsForWorkflowRun: listJobs,
        getWorkflowRun: async () => ({ data: {
          id: 123, path: ".github/workflows/production-release-request.yml",
          event: "workflow_dispatch", head_branch: "main", head_sha: requestSha,
        } }),
      },
    },
    // The first `lagging` reads see the dispatcher still running with its marker pending.
    paginate: async (method) => {
      if (method === listRuns) return [{ id: 456, head_sha: deploySha }];
      reads += 1;
      return reads > lagging ? jobs : jobs.map((job) => job === dispatcher
        ? { ...job, status: "in_progress", steps: [{ name: marker, conclusion: null }] } : job);
    },
  };
  await authorize(github, {
    repo: { owner: "LambdaLabsHQ", repo: "xmatrix" }, ref: "refs/tags/xmatrix-v0.16.339", runId: 456,
  }, { setFailed: (message) => failures.push(message) }, {
    env: { DEPLOY_SHA: deploySha, REQUEST_RUN_ID: "123", RELEASE_SCOPE: scope },
  }, fakeRequire);
  return failures;
}

test("tagged preflight accepts only the tested exact scope and its passed gates", async () => {
  assert.deepEqual(await runAuthorization(), []);
  assert.deepEqual(await runAuthorization({ scope: "hub,web,cli,desktop,android,ios" }), []);
  assert.notDeepEqual(await runAuthorization({ scope: "hub", marker: "Record successful web production authorization" }), []);
  for (const job of ["plan", "gates"]) {
    for (const conclusion of ["failure", "skipped", "cancelled"]) {
      assert.notDeepEqual(await runAuthorization({ overrides: { [job]: conclusion } }), [], `${job} ${conclusion}`);
    }
  }
  assert.notDeepEqual(await runAuthorization({ scope: "web,hub" }), []);
  assert.notDeepEqual(await runAuthorization({ scope: "desktop" }), []);
  assert.notDeepEqual(await runAuthorization({ marker: "Record successful hub production authorization" }), []);
  assert.notDeepEqual(await runAuthorization({ requestSha: "b".repeat(40) }), []);
  // The request's release commit (its SHA plus the stamped version) is the same authorization.
  assert.deepEqual(await runAuthorization({ deploySha: "c".repeat(40) }), []);
  assert.notDeepEqual(await runAuthorization({ deploySha: "c".repeat(40), requestSha: "b".repeat(40) }), []);
});

test("tagged preflight re-reads a dispatcher whose marker GitHub has not yet reported", async () => {
  assert.deepEqual(await runAuthorization({ lagging: 1 }), []);
});
