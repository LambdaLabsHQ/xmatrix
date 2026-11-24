import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  WEB_HANDOFF_ARCHIVE,
  WEB_HANDOFF_IDENTITY,
  createWebReleaseHandoff,
  restoreWebReleaseHandoff,
  verifyWebReleaseHandoff,
} from "./web-release-handoff.mjs";

const deploySha = "a".repeat(40);

function builtWebDirectory() {
  const root = mkdtempSync(path.join(os.tmpdir(), "xmatrix-web-handoff-"));
  const web = path.join(root, "web");
  mkdirSync(path.join(web, ".open-next", "assets"), { recursive: true });
  writeFileSync(path.join(web, ".open-next", "worker.js"), "export default {};\n");
  writeFileSync(path.join(web, ".open-next", "assets", "app.js"), "console.log('app');\n");
  return { root, web, handoff: path.join(root, "handoff"), target: path.join(root, "target") };
}

test("a Web build crosses the handoff intact for its exact commit", async () => {
  const { web, handoff, target } = builtWebDirectory();
  await createWebReleaseHandoff(handoff, web, deploySha);
  mkdirSync(target);
  await restoreWebReleaseHandoff(handoff, target, deploySha);
  assert.equal(readFileSync(path.join(target, ".open-next", "worker.js"), "utf8"), "export default {};\n");
  assert.equal(readFileSync(path.join(target, ".open-next", "assets", "app.js"), "utf8"), "console.log('app');\n");
});

test("a Web handoff built from another commit is refused", async () => {
  const { web, handoff, target } = builtWebDirectory();
  await createWebReleaseHandoff(handoff, web, deploySha);
  mkdirSync(target);
  await assert.rejects(restoreWebReleaseHandoff(handoff, target, "b".repeat(40)), /built from a{40}, not b{40}/u);
});

test("a tampered Web handoff is refused before extraction", async () => {
  const { web, handoff, target } = builtWebDirectory();
  await createWebReleaseHandoff(handoff, web, deploySha);
  appendFileSync(path.join(handoff, WEB_HANDOFF_ARCHIVE), "tampered");
  mkdirSync(target);
  await assert.rejects(restoreWebReleaseHandoff(handoff, target, deploySha), /size mismatch|SHA-256 mismatch/u);

  const second = builtWebDirectory();
  await createWebReleaseHandoff(second.handoff, second.web, deploySha);
  writeFileSync(path.join(second.handoff, WEB_HANDOFF_IDENTITY), `${JSON.stringify({ schema: 1, deploySha: "c".repeat(40) })}\n`);
  mkdirSync(second.target);
  await assert.rejects(restoreWebReleaseHandoff(second.handoff, second.target, deploySha), /mismatch/u);
});

test("a Web handoff never restores over an existing build", async () => {
  const { web, handoff } = builtWebDirectory();
  await createWebReleaseHandoff(handoff, web, deploySha);
  await assert.rejects(restoreWebReleaseHandoff(handoff, web, deploySha), /Refusing to restore over an existing/u);
});

test("a Web handoff requires an exact commit and real build output", async () => {
  const { root, handoff } = builtWebDirectory();
  const empty = path.join(root, "empty");
  mkdirSync(empty);
  await assert.rejects(createWebReleaseHandoff(handoff, empty, deploySha), /No OpenNext build output/u);
  await assert.rejects(createWebReleaseHandoff(handoff, empty, "main"), /exact 40-character commit/u);
});

test("a prebuilt Web handoff is reused only for its exact commit and intact bytes", async () => {
  const { web, handoff } = builtWebDirectory();
  await createWebReleaseHandoff(handoff, web, deploySha);
  await verifyWebReleaseHandoff(handoff, deploySha);
  await assert.rejects(verifyWebReleaseHandoff(handoff, "b".repeat(40)), /built from a{40}, not b{40}/u);
  appendFileSync(path.join(handoff, WEB_HANDOFF_ARCHIVE), "tampered");
  await assert.rejects(verifyWebReleaseHandoff(handoff, deploySha), /size mismatch|SHA-256 mismatch/u);
  await assert.rejects(verifyWebReleaseHandoff(path.join(handoff, "absent"), deploySha));
});

test("the train builds the Web beside its gates and only a tagged job deploys", async () => {
  const { parse } = await import("yaml");
  const read = (file) => parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
  const request = read("production-release-request.yml");
  const server = read("server-release.yml");
  const prebuild = request.jobs["web-prebuild"];
  assert.equal(prebuild.uses, "./.github/workflows/server-release.yml");
  assert.equal(prebuild.with.target, "web-prebuild");
  assert.equal(prebuild.with.deploy_sha, "${{ needs.plan.outputs.deploy_sha }}");
  assert.deepEqual([prebuild.needs].flat(), ["plan"]);
  // The gates never wait for the build; the dispatch waits for both.
  assert.ok(!request.jobs.gates.needs.includes("web-prebuild"));
  assert.ok(request.jobs["authorize-and-dispatch"].needs.includes("web-prebuild"));
  assert.doesNotMatch(request.jobs["authorize-and-dispatch"].if, /web-prebuild/u);
  // Off a tag, only the build may run, and only as the train's prebuild.
  for (const job of ["hub", "web"]) {
    assert.match(server.jobs[job].if, /^startsWith\(github\.ref, 'refs\/tags\/xmatrix-v'\) && inputs\.target == '/u, job);
  }
  assert.match(server.jobs.build.if, /github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch' && inputs\.target == 'web-prebuild'/u);
  const steps = server.jobs.build.steps;
  const built = steps.filter((step) => /Typecheck and build|source maps|Prepare verified Web build handoff/u.test(step.name ?? ""));
  assert.equal(built.length, 3);
  for (const step of built) assert.equal(step.if, "steps.prebuilt.outputs.hit != 'true'", step.name);
  const lookup = steps.find((step) => step.id === "prebuilt");
  assert.equal(lookup.if, "inputs.target == 'web-build'");
  assert.match(lookup.run, /web-release-handoff\.mjs verify/u);
});
