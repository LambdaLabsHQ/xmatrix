#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

export const partitionNames = [
  "node-checks",
  "web",
  "web-browser",
  "hub",
  "desktop",
  "android",
  "rust-cli",
  "duplicates"];

const rootSharedPaths = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "knip.jsonc",
  ".jscpd.json",
  "scripts/check-duplicates.mjs",
  "patches",
  "scripts/version.mjs",
  "scripts/release-version-order.mjs",
  "scripts/release-version-order.test.mjs",
  "scripts/ci.mjs",
  "scripts/ci-host-admission.mjs",
  "scripts/host-task-slots.mjs",
  ".oxlintrc.json",
  "packages/cli-rs/clippy.toml",
  "scripts/turbo-cache.mjs",
  "scripts/ci-script-tests.mjs",
  "scripts/ci-node-tests.mjs",
  "scripts/ci-progress.mjs",
  "scripts/ci-progress.test.mjs",
  "scripts/process-tree.mjs",
  "scripts/run-with-process-tree.mjs",
  "scripts/ci-areas.mjs",
  "scripts/ci-areas.test.mjs",
  "scripts/ci-ledger.mjs",
  "scripts/release-commit.mjs",
  "scripts/release-commit.test.mjs",
  "scripts/release-claim.mjs",
  "scripts/release-claim.test.mjs",
  "scripts/ci-ledger.test.mjs",
  ".github/workflows/ci-ledger.yml",
  "scripts/kache-env.mjs",
  "scripts/kache-env.test.mjs",
  "scripts/kache.toml",
  ".github/workflows/ci.yml"];

const githubWorkflowPaths = [".github/workflows"];
const githubActionPaths = [".github/actions"];
const ciAggregatePaths = [".github/scripts/check-ci-partitions.sh"];
const setupPnpmActionPaths = [".github/actions/setup-pnpm-node"];
const androidJavaActionPaths = [".github/actions/setup-android-java"];
const linuxCommonActionPaths = [".github/actions/clear-linux-proxy"];
const webWorkflowPaths = [".github/workflows/server-release.yml"];
const hubWorkflowPaths = [".github/workflows/server-release.yml"];
const rustWorkflowPaths = [".github/workflows/cli-build.yml", ".github/workflows/client-publish.yml"];
const androidWorkflowPaths = [".github/workflows/android-deploy.yml", ".github/workflows/client-publish.yml"];
const androidPaths = [
  "apps/android",
  "scripts/android-common.mjs",
  "scripts/android-env.mjs",
  "scripts/android-deploy.mjs",
  "scripts/android-bundle-web.mjs",
  "scripts/android-publish-github-release.mjs",
  "scripts/android-release-assets.mjs",
];

const releasePolicyPaths = [
  "packages/cli-rs/Cargo.toml",
  "packages/cli-rs/crates/runtime/Cargo.toml",
  "scripts/publish-github-release.mjs",
  "scripts/publish-github-release-upload.mjs",
  "scripts/release-publication-policy.mjs",
  "scripts/release-publication-policy.test.mjs",
  "scripts/verify-macos-cli-signature.sh",
  "scripts/release-asset-handoff.mjs",
  "scripts/web-release-handoff.mjs",
  ".github/workflows/cli-build.yml",
  ".github/workflows/client-publish.yml",
  ".github/workflows/release-promote.yml",
  ".github/workflows/desktop-release.yml",
  ".github/workflows/android-deploy.yml",
  ".github/workflows/ios-testflight.yml"];

const hubDeployPolicyPaths = [
  ".github/workflows/server-release.yml",
  "version.json",
  "scripts/hub-deploy-source-guard.mjs",
  "scripts/hub-deploy-source-guard.test.mjs",
  "scripts/hub-postdeploy-smoke.mjs",
  "scripts/hub-postdeploy-smoke.test.mjs"];

const rustToolchainPaths = [
  ".github/actions/configure-windows-runner",
  ".github/actions/setup-rust-kache",
  ".github/actions/setup-windows-rust-cli",
  ".github/scripts/kache-cache.ps1",
  ".github/scripts/reclaim-windows-rust-disk.ps1",
  ".github/scripts/rust-compile-jobs.sh",
  ".github/scripts/setup-kache.sh",
  ".github/scripts/setup-kache.ps1",
  ".github/scripts/test-kache-cache.ps1",
  ".github/scripts/test-reclaim-windows-rust-disk.ps1"];

function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function touches(files, ...roots) {
  return files.some((file) =>
    roots.some((root) => file === root || file.startsWith(`${root}/`)),
  );
}

export function affectedPartitions(changedFiles) {
  const files = changedFiles.map(normalizePath).filter(Boolean);
  const rootShared = touches(files, ...rootSharedPaths);
  const githubWorkflow = touches(files, ...githubWorkflowPaths);
  const githubAction = touches(files, ...githubActionPaths);
  const ciAggregate = touches(files, ...ciAggregatePaths);
  const setupPnpmAction = touches(files, ...setupPnpmActionPaths);
  const androidJavaAction = touches(files, ...androidJavaActionPaths);
  const linuxCommonAction = touches(files, ...linuxCommonActionPaths);
  const releasePolicy = touches(files, ...releasePolicyPaths);
  const hubDeployPolicy = touches(files, ...hubDeployPolicyPaths);
  const scriptTest = files.some(
    (file) => file.startsWith("scripts/") && file.endsWith(".test.mjs"),
  );
  const webWorkflow = touches(files, ...webWorkflowPaths);
  const hubWorkflow = touches(files, ...hubWorkflowPaths);
  const rustWorkflow = touches(files, ...rustWorkflowPaths);
  const androidWorkflow = touches(files, ...androidWorkflowPaths);
  const desktopRelease = touches(
    files,
    ".github/workflows/desktop-release.yml",
    ".github/workflows/client-publish.yml",
    "scripts/desktop-release-signing.test.mjs",
    "scripts/prepare-windows-desktop-release.mjs",
    "scripts/verify-macos-app-signature.sh",
  );
  const web =
    rootShared ||
    setupPnpmAction ||
    linuxCommonAction ||
    webWorkflow ||
    touches(files, "apps/web", "packages/db", "packages/protocol", "scripts/next-build-cache.mjs");
  const hub =
    rootShared ||
    setupPnpmAction ||
    hubWorkflow ||
    hubDeployPolicy ||
    touches(files, "packages/hub", "packages/db", "packages/protocol");
  const desktop =
    rootShared ||
    setupPnpmAction ||
    desktopRelease ||
    touches(files, "apps/desktop");
  const android =
    rootShared ||
    setupPnpmAction ||
    androidJavaAction ||
    linuxCommonAction ||
    androidWorkflow ||
    touches(files, ...androidPaths);
  const rustCli =
    rootShared ||
    setupPnpmAction ||
    linuxCommonAction ||
    rustWorkflow ||
    touches(files, "packages/cli-rs", "apps/web/public/install.sh", "apps/web/public/install.ps1",
      "scripts/install-daemon-setup.test.mjs", "scripts/install-daemon-setup.windows.test.mjs", ...rustToolchainPaths);
  // The gate covers the repository as a whole, including extensionless hooks
  // and newly introduced languages; a changed-path suffix must not bypass it.
  const duplicates = files.length > 0;
  const nodeChecks =
    githubWorkflow ||
    githubAction ||
    ciAggregate ||
    scriptTest ||
    releasePolicy ||
    hubDeployPolicy ||
    web ||
    hub ||
    desktop ||
    android ||
    touches(
      files,
      "packages/mock-agent",
      "packages/decision-model",
      "scripts/hub-network-e2e",
    );

  const affected = new Set();
  if (nodeChecks) affected.add("node-checks");
  if (web) {
    affected.add("web");
    affected.add("web-browser");
  }
  if (hub) affected.add("hub");
  if (desktop) affected.add("desktop");
  if (android) affected.add("android");
  if (rustCli) {
    affected.add("rust-cli");
  }
  if (duplicates) affected.add("duplicates");
  return partitionNames.filter((partition) => affected.has(partition));
}

export function githubOutputs(changedFiles) {
  const affected = new Set(affectedPartitions(changedFiles));
  return {
    node: affected.has("node-checks"),
    web: affected.has("web"),
    hub: affected.has("hub"),
    desktop: affected.has("desktop"),
    android: affected.has("android"),
    cli: affected.has("rust-cli"),
    duplicates: affected.has("duplicates"),
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const changedFiles = Buffer.concat(chunks).toString("utf8").split("\0");
  const outputs = githubOutputs(changedFiles);
  for (const [name, affected] of Object.entries(outputs)) {
    console.log(`${name}=${affected}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
