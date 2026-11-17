import assert from "node:assert/strict";
import test from "node:test";

import {
  baselineVersion,
  isDurableObjectLifecycleRejection,
  releaseHub,
  uploadedVersionId,
  versionTag,
} from "./hub-canary-release.mjs";

const NEW = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const NEW_TAG = "a".repeat(40);
const OLD_TAG = "b".repeat(40);

function harness({ status, recent = [], uploadError, smokeErrorAt = null } = {}) {
  const calls = [];
  const logs = [];
  let smokeCalls = 0;
  return {
    calls,
    logs,
    deps: {
      run(args) {
        calls.push(args.join(" "));
        if (args[0] === "versions" && args[1] === "upload") {
          if (uploadError) {
            const error = new Error("upload failed");
            error.stdout = uploadError;
            throw error;
          }
          return { stdout: `Uploaded xmatrix-hub (Version ID: ${NEW})`, stderr: "" };
        }
        if (args[0] === "deployments" && args[1] === "status") {
          return { stdout: JSON.stringify(status), stderr: "" };
        }
        if (args[0] === "versions" && args[1] === "list") {
          return { stdout: JSON.stringify(recent), stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
      async smoke() {
        smokeCalls += 1;
        if (smokeErrorAt !== null && smokeCalls === smokeErrorAt) throw new Error("smoke failed");
        return { status: "ok", service: "xmatrix-hub" };
      },
      async sleep() {},
      log(message) { logs.push(message); },
      fetchImpl: async () => Response.json({
        status: "ok", service: "xmatrix-hub", deployment: { versionId: NEW, revision: NEW_TAG },
      }),
    },
    smokeCalls: () => smokeCalls,
  };
}

const options = {
  config: "/repo/packages/hub/wrangler.generated.production.toml",
  cwd: "/repo/packages/hub",
  worker: "xmatrix-hub",
  tag: NEW_TAG,
  secretsFile: "/tmp/secrets.json",
  outdir: "/tmp/bundle",
  defines: ['XMATRIX_SENTRY_DSN:"https://abc@sentry.example/1"'],
  smokeUrl: "https://xmatrix-hub.example.test/",
  canaryPercent: 10,
  observeSeconds: 10,
};

test("a Durable Object lifecycle change is recognized and takes the plain deploy path", async () => {
  assert.equal(isDurableObjectLifecycleRejection("error code: 10211"), true);
  assert.equal(isDurableObjectLifecycleRejection("Cannot upload: Durable Object migration is pending"), true);
  assert.equal(isDurableObjectLifecycleRejection("network timeout"), false);

  const { calls, deps } = harness({ uploadError: "error code: 10211" });
  const result = await releaseHub(options, deps);
  assert.equal(result.mode, "deploy");
  assert.equal(calls.some((call) => call.startsWith("deploy --config")), true);
  assert.equal(calls.some((call) => call.startsWith("versions deploy")), false);
});

test("a canary uploads, proves 0%, observes 10%, then promotes", async () => {
  const status = { versions: [{ version_id: OLD, percentage: 100 }] };
  const recent = [{ id: OLD, metadata: { tag: OLD_TAG } }];
  const h = harness({ status, recent });
  const result = await releaseHub(options, h.deps);
  assert.equal(result.mode, "canary");
  assert.deepEqual(h.calls.filter((call) => call.startsWith("versions deploy")), [
    `versions deploy --config ${options.config} ${OLD}@100 ${NEW}@0 --yes`,
    `versions deploy --config ${options.config} ${OLD}@90 ${NEW}@10 --yes`,
    `versions deploy --config ${options.config} ${NEW}@100 --yes`,
  ]);
  assert.equal(h.smokeCalls(), 3);
});

test("a failed canary smoke rolls the code back to the running version and fails", async () => {
  const status = { versions: [{ version_id: OLD, percentage: 100 }] };
  const recent = [{ id: OLD, metadata: { tag: OLD_TAG } }];
  const h = harness({ status, recent, smokeErrorAt: 1 });
  await assert.rejects(releaseHub(options, h.deps), /rolled the Hub back to/u);
  assert.deepEqual(h.calls.filter((call) => call.startsWith("versions deploy")), [
    `versions deploy --config ${options.config} ${OLD}@100 ${NEW}@0 --yes`,
    `versions deploy --config ${options.config} ${OLD}@100 --yes`,
  ]);
});

test("a canary that sees an unknown live revision rolls back", async () => {
  const status = { versions: [{ version_id: OLD, percentage: 100 }] };
  const recent = [{ id: OLD, metadata: { tag: OLD_TAG } }];
  const h = harness({ status, recent });
  h.deps.fetchImpl = async () => Response.json({
    status: "ok", service: "xmatrix-hub", deployment: { versionId: "other", revision: "c".repeat(40) },
  });
  await assert.rejects(releaseHub(options, h.deps), /expected one of/u);
  assert.equal(h.calls.includes(`versions deploy --config ${options.config} ${OLD}@100 --yes`), true);
});

test("the first version is published directly", async () => {
  const h = harness({ status: {} });
  const result = await releaseHub(options, h.deps);
  assert.equal(result.mode, "direct");
  assert.deepEqual(h.calls.filter((call) => call.startsWith("versions deploy")), [
    `versions deploy --config ${options.config} ${NEW}@100 --yes`,
  ]);
});

test("version ids, baselines and tags are read from wrangler's output", () => {
  assert.equal(uploadedVersionId(`Uploaded xmatrix-hub (Version ID: ${NEW})`), NEW);
  assert.equal(uploadedVersionId("no id here"), null);
  assert.deepEqual(
    baselineVersion({ versions: [{ version_id: OLD, percentage: 90 }, { version_id: NEW, percentage: 10 }] }),
    { id: OLD, percentage: 90 },
  );
  assert.equal(baselineVersion({}), null);
  assert.equal(versionTag([{ id: OLD, metadata: { tag: OLD_TAG } }], OLD), OLD_TAG);
  assert.equal(versionTag([{ id: OLD, metadata: { tag: "short" } }], OLD), null);
});
