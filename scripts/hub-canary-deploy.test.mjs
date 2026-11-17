import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CANARY_PERCENT,
  deployWithCanary,
  isDurableObjectLifecycleRefusal,
  previousDeploymentVersion,
  trafficArguments,
  versionIdForTag,
} from "./hub-canary-deploy.mjs";

const TAG = "a".repeat(40);
const PREVIOUS = "previous-version";
const NEXT = "next-version";

function harness({ statusVersions = [{ version_id: PREVIOUS, percentage: 100 }], healthErrorAt = null, failOn = null } = {}) {
  const calls = [];
  const healthCalls = [];
  const sleeps = [];
  let healthRuns = 0;
  const run = async (args) => {
    calls.push(args.join(" "));
    if (failOn && failOn(args.join(" "))) throw new Error("injected failure");
    if (args[0] === "deployments" && args[1] === "status") {
      return { stdout: JSON.stringify({ versions: statusVersions }) };
    }
    if (args[0] === "versions" && args[1] === "list") {
      return { stdout: JSON.stringify([{ id: NEXT, annotations: { "workers/tag": TAG } }, { id: PREVIOUS }]) };
    }
    return { stdout: "" };
  };
  const health = async (options) => {
    healthCalls.push(options);
    healthRuns += 1;
    if (healthErrorAt !== null && healthRuns === healthErrorAt) throw new Error("canary is not healthy");
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  return { calls, healthCalls, sleeps, run, health, sleep };
}

function options(parts) {
  return {
    run: parts.run,
    health: parts.health,
    sleep: parts.sleep,
    log: () => {},
    workerName: "xmatrix-hub",
    tag: TAG,
    config: "wrangler.generated.production.toml",
    secretsFile: "/tmp/secrets.json",
    outdir: "/tmp/bundle",
    url: "https://xmatrix-hub.example.test/",
    defines: ["XMATRIX_SENTRY_DSN:\"https://example.test/1\""],
    holdMs: 120_000,
  };
}

test("a release serves a canary split, verifies the new version, then takes 100%", async () => {
  const parts = harness();
  const result = await deployWithCanary(options(parts));

  assert.equal(result.mode, "canary");
  assert.equal(result.previousVersionId, PREVIOUS);
  assert.equal(result.versionId, NEXT);
  assert.equal(DEFAULT_CANARY_PERCENT, 10);
  assert.ok(parts.calls[1].startsWith("versions upload"));
  assert.match(parts.calls[1], /--tag a{40}/u);
  assert.match(parts.calls[1], /--secrets-file \/tmp\/secrets\.json/u);
  assert.match(parts.calls[1], /--define XMATRIX_SENTRY_DSN:"https:\/\/example\.test\/1"/u);
  assert.match(parts.calls[3], new RegExp(`versions deploy .*--version-id ${NEXT} --percentage 10 --version-id ${PREVIOUS} --percentage 90`, "u"));
  assert.deepEqual(parts.healthCalls, [
    { expectedSha: TAG, versionOverride: `xmatrix-hub="${NEXT}"` },
    { expectedSha: TAG, versionOverride: `xmatrix-hub="${NEXT}"` },
    { expectedSha: TAG },
  ]);
  assert.deepEqual(parts.sleeps, [120_000]);
  assert.match(parts.calls[4], new RegExp(`versions deploy .*--version-id ${NEXT} --percentage 100`, "u"));
});

test("a canary that fails verification rolls production back before failing the release", async () => {
  const parts = harness({ healthErrorAt: 1 });
  await assert.rejects(deployWithCanary(options(parts)), /canary verification failed: canary is not healthy; rolled back to previous-version/u);
  assert.ok(parts.calls.some((call) => call.includes(`--version-id ${PREVIOUS} --percentage 100`)));
  assert.ok(!parts.calls.some((call) => call.includes(`--version-id ${NEXT} --percentage 100`)));
  assert.equal(parts.healthCalls.length, 1);
});

test("a failing promotion rolls back and never reports the release as deployed", async () => {
  const parts = harness({ failOn: (call) => call.includes(`${NEXT} --percentage 100`) });
  await assert.rejects(deployWithCanary(options(parts)), /promotion failed: injected failure; rolled back to previous-version/u);
  assert.ok(parts.calls.some((call) => call.includes(`${PREVIOUS} --percentage 100`)));
});

test("a Durable Object lifecycle refusal deploys once and skips the canary", async () => {
  const parts = harness();
  const realRun = parts.run;
  parts.run = async (args) => {
    if (args[0] === "versions" && args[1] === "upload") {
      const error = new Error("wrangler versions upload failed (1): cannot upload a Durable Object migration");
      error.stderr = "A Durable Object class lifecycle change cannot be uploaded as a version.";
      throw error;
    }
    return realRun(args);
  };
  const result = await deployWithCanary(options(parts));
  assert.equal(result.mode, "single");
  assert.equal(result.reason, "durable-object-lifecycle");
  assert.ok(parts.calls.some((call) => call.startsWith("deploy ")));
  assert.ok(!parts.calls.some((call) => call.startsWith("versions deploy")));
  assert.deepEqual(parts.healthCalls, [{ expectedSha: TAG }]);
});

test("a first deployment takes all traffic without a rollback base", async () => {
  const parts = harness({ statusVersions: [] });
  const result = await deployWithCanary(options(parts));
  assert.equal(result.mode, "single");
  assert.equal(result.reason, "no-previous-deployment");
  assert.ok(!parts.calls.some((call) => call.includes("previous-version")));
  assert.deepEqual(parts.healthCalls, [{ expectedSha: TAG }]);
});

test("the newest version carrying the release tag is scheduled", () => {
  assert.equal(versionIdForTag([{ id: NEXT, annotations: { "workers/tag": TAG } }], TAG), NEXT);
  assert.equal(versionIdForTag([
    { id: "older", annotations: { "workers/tag": TAG }, metadata: { created_on: "2026-01-01T00:00:00Z" } },
    { id: "newer", annotations: { "workers/tag": TAG }, metadata: { created_on: "2026-01-02T00:00:00Z" } },
  ], TAG), "newer");
  assert.equal(versionIdForTag([{ id: NEXT }], TAG), null);
  assert.equal(versionIdForTag(undefined, TAG), null);
});

test("a split deployment, an incomplete one, or a missing id is not a rollback base", () => {
  assert.equal(previousDeploymentVersion({ versions: [{ version_id: PREVIOUS, percentage: 100 }] }), PREVIOUS);
  assert.equal(previousDeploymentVersion({ versions: [{ version_id: "new", percentage: 10 }, { version_id: PREVIOUS, percentage: 90 }] }), null);
  assert.equal(previousDeploymentVersion({ versions: [] }), null);
  assert.equal(previousDeploymentVersion({ versions: [{ version_id: PREVIOUS, percentage: 90 }] }), null);
  assert.equal(previousDeploymentVersion(undefined), null);
});

test("the first version takes 100% and a split keeps the configured percentage", () => {
  assert.deepEqual(trafficArguments("v", null, 10), ["--version-id", "v", "--percentage", "100"]);
  assert.deepEqual(trafficArguments("new", "old", 10),
    ["--version-id", "new", "--percentage", "10", "--version-id", "old", "--percentage", "90"]);
});

test("only a Durable Object lifecycle refusal skips the canary", () => {
  assert.equal(isDurableObjectLifecycleRefusal("Cannot upload Durable Object migration"), true);
  assert.equal(isDurableObjectLifecycleRefusal("error code 10211"), true);
  assert.equal(isDurableObjectLifecycleRefusal("Authentication error"), false);
  assert.equal(isDurableObjectLifecycleRefusal(undefined), false);
});

test("a deployment without its target URL or tag fails before touching production", async () => {
  const parts = harness();
  await assert.rejects(deployWithCanary({ ...options(parts), url: "" }), /missing required url/u);
  await assert.rejects(deployWithCanary({ ...options(parts), tag: "not-a-sha" }), /full Git SHA/u);
  assert.deepEqual(parts.calls, []);
});
