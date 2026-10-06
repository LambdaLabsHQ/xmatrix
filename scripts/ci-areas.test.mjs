import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  affectedPartitions,
  githubOutputs,
} from "./ci-areas.mjs";
import { discoverScriptTests } from "./ci-script-tests.mjs";

test("documentation-only changes do not run unrelated build partitions", () => {
  assert.deepEqual(affectedPartitions(["docs/architecture.md"]), ["duplicates"]);
});

test("decision-model changes run the Node checks containing the evaluation tests", () => {
  assert.deepEqual(affectedPartitions(["packages/decision-model/src/jev.mjs"]), ["node-checks", "duplicates"]);
  assert.ok(discoverScriptTests(process.cwd()).includes("scripts/jev-evaluate.test.mjs"));
});

test("web changes select unit, build, and browser partitions for CI", () => {
  assert.deepEqual(affectedPartitions(["apps/web/src/app.tsx"]), ["node-checks", "web", "web-browser", "duplicates"]);
});

test("protocol source, manifest, and tests run every dependent Node partition", () => {
  for (const file of [
    "packages\\protocol\\src\\index.ts",
    "packages/protocol/package.json",
    "packages/protocol/test/agent-mention.test.mjs"]) {
    assert.deepEqual(affectedPartitions([file]), ["node-checks", "web", "web-browser", "hub", "duplicates"], file);
  }
});

test("root build configuration changes run every partition", () => {
  assert.deepEqual(affectedPartitions(["turbo.json"]), ["node-checks", "web", "web-browser", "hub", "desktop", "android", "rust-cli", "duplicates"]);
});

test("shared CI execution changes run every partition", () => {
  for (const file of ["scripts/ci-node-tests.mjs", "scripts/process-tree.mjs"]) {
    assert.deepEqual(affectedPartitions([file]), ["node-checks", "web", "web-browser", "hub", "desktop", "android", "rust-cli", "duplicates"]);
  }
});

test("Rust-only changes select tests and duplicate detection without Node builds", () => {
  assert.deepEqual(affectedPartitions(["packages/cli-rs/src/main.rs"]), ["rust-cli", "duplicates"]);
});

test("Rust runner setup changes cannot bypass both platform test partitions", () => {
  for (const file of [
    ".github/actions/configure-windows-runner/action.yml",
    ".github/actions/setup-rust-kache/action.yml",
    ".github/actions/setup-windows-rust-cli/action.yml"]) {
    assert.deepEqual(
      affectedPartitions([file]),
      ["node-checks", "rust-cli", "duplicates"],
      file,
    );
  }
  for (const file of [
    ".github/scripts/kache-cache.ps1",
    ".github/scripts/reclaim-windows-rust-disk.ps1",
    ".github/scripts/rust-compile-jobs.sh",
    ".github/scripts/setup-kache.sh",
    ".github/scripts/setup-kache.ps1",
    ".github/scripts/test-kache-cache.ps1",
    ".github/scripts/test-reclaim-windows-rust-disk.ps1"]) {
    assert.deepEqual(affectedPartitions([file]), ["rust-cli", "duplicates"], file);
  }
});

test("common GitHub actions trigger every partition that consumes them", () => {
  assert.deepEqual(
    affectedPartitions([".github/actions/setup-pnpm-node/action.yml"]),
    ["node-checks", "web", "web-browser", "hub", "desktop", "android", "rust-cli", "duplicates"],
  );
  assert.deepEqual(
    affectedPartitions([".github/actions/clear-linux-proxy/action.yml"]),
    ["node-checks", "web", "web-browser", "android", "rust-cli", "duplicates"],
  );
  assert.deepEqual(
    affectedPartitions([".github/actions/setup-android-java/action.yml"]),
    ["node-checks", "android", "duplicates"],
  );
  assert.deepEqual(
    affectedPartitions([".github/actions/prepare-git-checkout/action.yml"]),
    ["node-checks", "duplicates"],
  );
  assert.deepEqual(affectedPartitions([".github/actions/future/action.yml"]), ["node-checks", "duplicates"]);
});

test("every workflow local action reference resolves to an action definition", () => {
  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  const workflowsDir = fileURLToPath(
    new URL("../.github/workflows", import.meta.url),
  );
  const workflowFiles = fs.readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/u.test(name));

  for (const workflowFile of workflowFiles) {
    const source = fs.readFileSync(`${workflowsDir}/${workflowFile}`, "utf8");
    const references = source.matchAll(
      /uses:\s+(\.\/\.github\/actions\/[A-Za-z0-9._/-]+)/gu,
    );
    for (const [, reference] of references) {
      const actionDir = `${rootDir}/${reference.slice(2)}`;
      const definitions = ["action.yml", "action.yaml", "Dockerfile"];
      assert.ok(
        definitions.some((name) => fs.existsSync(`${actionDir}/${name}`)),
        `${workflowFile} references missing local action ${reference}`,
      );
    }
  }
});

test("product workflows trigger their corresponding validation partitions", () => {
  assert.deepEqual(affectedPartitions([".github/workflows/server-release.yml"]), ["node-checks", "web", "web-browser", "hub", "duplicates"]);
  // Release handoff helpers are covered by the release policy tests.
  for (const helper of ["scripts/release-asset-handoff.mjs", "scripts/web-release-handoff.mjs"]) {
    assert.deepEqual(affectedPartitions([helper]), ["node-checks", "duplicates"]);
  }
  assert.deepEqual(affectedPartitions([".github/workflows/client-publish.yml"]), ["node-checks", "desktop", "android", "rust-cli", "duplicates"]);
  assert.deepEqual(affectedPartitions([".github/workflows/android-deploy.yml"]), ["node-checks", "android", "duplicates"]);
  assert.deepEqual(affectedPartitions([".github/workflows/future.yml"]), ["node-checks", "duplicates"]);
});

test("desktop release signing changes run Node and desktop checks", () => {
  assert.deepEqual(affectedPartitions([".github/workflows/desktop-release.yml"]), ["node-checks", "desktop", "duplicates"]);
  assert.deepEqual(affectedPartitions(["scripts/desktop-release-signing.test.mjs"]), ["node-checks", "desktop", "duplicates"]);
  assert.deepEqual(affectedPartitions(["scripts/prepare-windows-desktop-release.mjs"]), ["node-checks", "desktop", "duplicates"]);
  assert.deepEqual(affectedPartitions(["scripts/verify-macos-app-signature.sh"]), ["node-checks", "desktop", "duplicates"]);
});

test("Android changes run the required native partition and shared contract tests", () => {
  for (const file of [
    "apps/android/app/src/main/java/sh/xmatrix/app/MainActivity.java",
    "scripts/android-deploy.mjs",
    "scripts/android-publish-github-release.mjs",
  ]) {
    assert.deepEqual(affectedPartitions([file]), ["node-checks", "android", "duplicates"], file);
  }
});

test("release publication policy changes always run their Node guard tests", () => {
  assert.deepEqual(affectedPartitions(["scripts/publish-github-release-upload.mjs"]), ["node-checks", "duplicates"]);
  assert.deepEqual(affectedPartitions(["scripts/release-publication-policy.mjs"]), ["node-checks", "duplicates"]);
  assert.deepEqual(affectedPartitions(["scripts/verify-macos-cli-signature.sh"]), ["node-checks", "duplicates"]);
  assert.deepEqual(affectedPartitions([".github/workflows/client-publish.yml"]), ["node-checks", "desktop", "android", "rust-cli", "duplicates"]);
  for (const manifest of [
    "packages/cli-rs/Cargo.toml",
    "packages/cli-rs/crates/runtime/Cargo.toml"]) {
    assert.deepEqual(affectedPartitions([manifest]), ["node-checks", "rust-cli", "duplicates"]);
  }
});

test("new script tests always select Node checks and enter the discovered test plan", () => {
  assert.deepEqual(affectedPartitions(["scripts/future-contract.test.mjs"]), ["node-checks", "duplicates"]);
  assert.deepEqual(affectedPartitions(["scripts/nested/future-contract.test.mjs"]), ["node-checks", "duplicates"]);

  const rootDir = fileURLToPath(new URL("..", import.meta.url));
  assert.ok(discoverScriptTests(rootDir).includes("scripts/ci-aggregate.test.mjs"));

  const runner = fs.readFileSync(new URL("./ci.mjs", import.meta.url), "utf8");
  assert.match(runner, /nodeTestStages\(\{ allFiles: scriptTests \}\)/u);
});

test("Hub deploy gate changes run both contract checks and the required Hub suite", () => {
  for (const file of [
    ".github/workflows/server-release.yml",
    "scripts/hub-deploy-source-guard.mjs",
    "scripts/hub-deploy-source-guard.test.mjs",
    "scripts/hub-postdeploy-smoke.mjs",
    "scripts/hub-postdeploy-smoke.test.mjs"]) {
     assert.deepEqual(affectedPartitions([file]), file.endsWith("server-release.yml")
      ? ["node-checks", "web", "web-browser", "hub", "duplicates"] : ["node-checks", "hub", "duplicates"], file);
   }
});

test("GitHub output names preserve the workflow contract", () => {
  assert.deepEqual(githubOutputs(["apps/desktop/src/main.ts"]), {
    node: true,
    web: false,
    hub: false,
    desktop: true,
    android: false,
    cli: false,
    duplicates: true,
  });
});

test("installer changes require the CLI lane with native PowerShell coverage", () => {
  for (const file of ["apps/web/public/install.sh", "apps/web/public/install.ps1", "scripts/install-daemon-setup.windows.test.mjs"]) {
    assert.ok(affectedPartitions([file]).includes("rust-cli"), file);
  }
});
