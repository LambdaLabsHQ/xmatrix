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
