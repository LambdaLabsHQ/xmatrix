import { expandWorkflowAnchors } from "./workflow-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import {
  assertAnnotatedTagTargetsCommit,
  assertImmutableReleaseTransaction,
  assertImmutableTagCanBeUsed,
  isImmutableVersionTag,
  releaseNotesWithTransaction,
} from "./release-publication-policy.mjs";
import {
  DEFAULT_STALL_SPEED_LIMIT_BYTES,
  DEFAULT_STALL_SPEED_TIME_SECONDS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  buildCurlUploadArgs,
} from "./publish-github-release-upload.mjs";

const transactionId = "29365232755:1";
// The CLI train uploads release parts in cli-build.yml and seals them in
// client-publish.yml; policy reads them as one prepare/build/release sequence.
const cliReleaseWorkflow = [
  "../.github/workflows/cli-build.yml",
  "../.github/workflows/client-publish.yml",
].map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

// Owning modules may be peels via include!; scan the monofile plus included sections.

function draftRelease(owner = transactionId) {
  return {
    draft: true,
    body: releaseNotesWithTransaction("Release notes", owner),
  };
}

test("stable product tags are immutable while the dev channel remains mutable", () => {
  assert.equal(isImmutableVersionTag("cli-v0.11.51"), true);
  assert.equal(isImmutableVersionTag("desktop-v0.11.51"), true);
  assert.equal(isImmutableVersionTag("android-v0.11.51"), true);
  assert.equal(isImmutableVersionTag("xmatrix-v0.16.3"), true);
  assert.equal(isImmutableVersionTag("desktop-dev"), false);
});

test("release notes cannot forge a different transaction owner", () => {
  assert.throws(
    () => releaseNotesWithTransaction("Notes\n\n<!-- xmatrix-release-transaction:another-run:1 -->", transactionId),
    /must not contain an xMatrix release transaction marker/
  );
});

test("one run attempt may continue its own unpublished release transaction", () => {
  const release = draftRelease();

  assert.doesNotThrow(() =>
    assertImmutableReleaseTransaction({
      release,
      tag: "cli-v0.11.51",
      transactionId,
    })
  );
  assert.doesNotThrow(() =>
    assertImmutableTagCanBeUsed({
      release,
      tag: "cli-v0.11.51",
      tagExists: true,
      transactionId,
    })
  );
});

test("published releases cannot be changed by the original run attempt", () => {
  const release = { ...draftRelease(), draft: false };

  assert.throws(
    () =>
      assertImmutableReleaseTransaction({
        release,
        tag: "cli-v0.11.51",
        transactionId,
      }),
    /already published and immutable.*Bump version\.json/
  );
});

test("a later run may claim an unpublished draft for the same product version", () => {
  const release = draftRelease("29365232755:1");

  assert.doesNotThrow(() =>
    assertImmutableReleaseTransaction({
      release,
      tag: "cli-v0.11.51",
      transactionId: "29365232755:2",
    })
  );
  assert.doesNotThrow(() =>
    assertImmutableTagCanBeUsed({
      release,
      tag: "cli-v0.11.51",
      tagExists: true,
      transactionId: "29365232755:2",
    })
  );
});

test("an orphaned version tag without a published release remains reclaimable", () => {
  assert.doesNotThrow(() =>
    assertImmutableTagCanBeUsed({
      release: null,
      tag: "cli-v0.11.51",
      tagExists: true,
      transactionId,
    })
  );
});

test("an existing annotated candidate tag is preserved only at the exact release commit", () => {
  const expectedSha = "a".repeat(40);
  const exactTagObject = {
    object: { type: "commit", sha: expectedSha },
  };

  assert.equal(
    assertAnnotatedTagTargetsCommit({
      tag: "xmatrix-v0.16.40",
      expectedSha,
      tagObject: exactTagObject,
    }),
    expectedSha
  );
  assert.throws(
    () =>
      assertAnnotatedTagTargetsCommit({
        tag: "xmatrix-v0.16.40",
        expectedSha,
        tagObject: { object: { type: "commit", sha: "b".repeat(40) } },
      }),
    /expected immutable commit/u
  );
  assert.throws(
    () =>
      assertAnnotatedTagTargetsCommit({
        tag: "xmatrix-v0.16.40",
        expectedSha,
        tagObject: { object: { type: "tag", sha: "b".repeat(40) } },
      }),
    /directly target one Git commit/u
  );
});

test("a stalled GitHub upload dies in 60s instead of hanging past the Actions step", () => {
  const publisher = fs.readFileSync(new URL("./publish-github-release.mjs", import.meta.url), "utf8");
  const cli = cliReleaseWorkflow;
  const desktop = expandWorkflowAnchors(fs.readFileSync(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8"));
  const archive = expandWorkflowAnchors(fs.readFileSync(new URL("../.github/workflows/archive-release-assets.yml", import.meta.url), "utf8"));
  assert.equal(DEFAULT_UPLOAD_TIMEOUT_MS, 600_000);
  assert.equal(DEFAULT_STALL_SPEED_LIMIT_BYTES, 102_400);
  assert.equal(DEFAULT_STALL_SPEED_TIME_SECONDS, 60);

  const args = buildCurlUploadArgs({
    uploadUrl: "https://uploads.github.com/repos/o/r/releases/1/assets?name=a.zip",
    assetPath: "a.zip",
    token: "token",
    size: 120,
    timeoutSeconds: Math.ceil(DEFAULT_UPLOAD_TIMEOUT_MS / 1000),
    speedLimitBytes: DEFAULT_STALL_SPEED_LIMIT_BYTES,
    speedTimeSeconds: DEFAULT_STALL_SPEED_TIME_SECONDS,
  });

  assert.ok(Number(args[args.indexOf("--max-time") + 1]) <= 600);
  assert.equal(args[args.indexOf("--speed-limit") + 1], "102400");
  assert.equal(args[args.indexOf("--speed-time") + 1], "60");
  assert.match(publisher, /from "\.\/publish-github-release-upload\.mjs"/);
  assert.match(publisher, /Preserved annotated tag/);
  assert.match(publisher, /assertAnnotatedTagTargetsCommit/);
  assert.match(publisher, /buildCurlUploadArgs\(/);
  assert.doesNotMatch(publisher, /1800000/);
  assert.doesNotMatch(publisher, /Skipped existing/);
  assert.doesNotMatch(publisher, /existingReleaseAssetIsReusable/);
  assert.doesNotMatch(cli, /publish-github-release\.mjs/u);
  assert.doesNotMatch(desktop, /publish-github-release\.mjs/u);
  assert.match(
    archive,
    /timeout-minutes: 90[\s\S]*GITHUB_RELEASE_UPLOAD_TIMEOUT_MS=1200000[\s\S]*publish-github-release\.mjs/u
  );
});

test("shared client publication refuses unknown components and tags that are not its immutable release", () => {
  const workflow = parse(fs.readFileSync(new URL("../.github/workflows/client-publish.yml", import.meta.url), "utf8"));
  const script = workflow.jobs.release.steps.find((step) => step.name === "Require an explicit supported client release")
    .run.match(/<<'SCRIPT'\n([\s\S]*?)\nSCRIPT/u)[1];
  const validate = new Function("process", script);
  for (const [component, tag] of [
    ["web", "web-v1.2.3"], ["", ""], ["cli", ""], ["cli", "cli-dev"], ["cli", "xmatrix-v1.2.3"],
    ["android", ""], ["desktop", "cli-v1.2.3"],
  ]) {
    assert.throws(() => validate({ env: { RELEASE_COMPONENT: component, RELEASE_TAG: tag } }));
  }
  for (const [component, tag] of [["cli", "cli-v1.2.3"], ["android", "android-v1.2.3"], ["desktop", "desktop-v1.2.3"]]) {
    assert.doesNotThrow(() => validate({ env: { RELEASE_COMPONENT: component, RELEASE_TAG: tag } }));
  }
});

test("archival proves old or nested Android publication and rejects ambiguous or unrelated evidence", async () => {
  const workflow = parse(fs.readFileSync(new URL("../.github/workflows/archive-release-assets.yml", import.meta.url), "utf8"));
  const script = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
    .find((step) => step.name === "Require the completed exact-scope production train").with.script;
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)("github", "context", "core", "process", script);
  async function authorize(names, overrides = {}) {
    const errors = [], outputs = {};
    const jobs = [
      { name: "deployment receipt", steps: [{ name: "Record successful android component deployment", conclusion: "success" }] },
      { name: "verify-production-postgres", conclusion: "skipped" },
      { name: "selected train receipt", conclusion: "success" },
      ...names.map((name) => ({ name, conclusion: "success" })),
    ];
    const run = { id: 42, path: ".github/workflows/production-release.yml", head_sha: "a".repeat(40), conclusion: "success", run_attempt: 2 };
    await execute({ rest: { actions: { getWorkflowRun: async () => ({ data: run }), listJobsForWorkflowRun() {} } }, paginate: async () => jobs },
      { repo: { owner: "fixture", repo: "fixture" } },
      { setFailed: (error) => errors.push(error), setOutput: (key, value) => { outputs[key] = value; } },
      { env: { SOURCE_SCOPE: "android", SOURCE_RUN_ID: "42", SOURCE_SHA: run.head_sha, SOURCE_RUN_ATTEMPT: "2", ...overrides } });
    return { errors, outputs };
  }
  for (const name of ["android / release", "android / release / release"]) {
    const result = await authorize([name]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.outputs.recover_receipt, "false");
  }
  for (const [names, overrides] of [
    [["android / release", "android / release / release"], {}],
    [["android / release / release", "cli / release"], {}],
    [["android / release / release"], { SOURCE_RUN_ATTEMPT: "1" }],
    [["android / release / release"], { SOURCE_SCOPE: "cli" }],
  ]) {
    const result = await authorize(names, overrides);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.outputs, {});
  }
});
