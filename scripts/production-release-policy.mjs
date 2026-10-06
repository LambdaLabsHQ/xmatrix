#!/usr/bin/env node

import { gitOutput } from "./git-output.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareSemver } from "./release-version-order.mjs";
import { verifyReleaseCommit } from "./release-commit.mjs";

export const PRODUCTION_BASELINE_VERSION = "0.16.2";
const TAG_PATTERN = /^xmatrix-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function productionVersionFromTag(tag) {
  const match = TAG_PATTERN.exec(tag ?? "");
  if (!match) {
    throw new Error(
      `Invalid production tag '${tag ?? ""}'. Expected xmatrix-vMAJOR.MINOR.PATCH without prerelease or build metadata.`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function productionTagFromVersion(version) {
  return `xmatrix-v${productionVersionFromTag(`xmatrix-v${version}`)}`;
}

export function validateCandidateTag({
  version,
  candidateSha,
  existingTagSha = null,
  baselineVersion = PRODUCTION_BASELINE_VERSION,
}) {
  const tag = productionTagFromVersion(version);
  if (!/^[0-9a-f]{40}$/iu.test(candidateSha ?? "")) {
    throw new Error("Candidate SHA must be one full Git commit id.");
  }
  if (compareSemver(version, baselineVersion) <= 0) {
    throw new Error(
      `Candidate version ${version} must be newer than production baseline ${baselineVersion}.`,
    );
  }
  if (existingTagSha && existingTagSha !== candidateSha) {
    throw new Error(`Immutable tag ${tag} already points to ${existingTagSha}; refusing to move it.`);
  }
  return { tag, idempotent: existingTagSha === candidateSha };
}

export function validateProductionRelease({
  tag,
  version,
  tagSha,
  checkoutSha,
  lastProductionVersion = PRODUCTION_BASELINE_VERSION,
  alreadyPublishedSha = null,
}) {
  const tagVersion = productionVersionFromTag(tag);
  if (tagVersion !== version) {
    throw new Error(`Tag ${tag} does not match version.json ${version}.`);
  }
  if (tagSha !== checkoutSha) {
    throw new Error(`Tagged SHA ${tagSha} does not match checkout SHA ${checkoutSha}.`);
  }
  if (alreadyPublishedSha && alreadyPublishedSha !== checkoutSha) {
    throw new Error(`Published production receipt ${tag} belongs to a different commit.`);
  }
  if (!alreadyPublishedSha && compareSemver(version, lastProductionVersion) <= 0) {
    throw new Error(
      `Production version ${version} must be newer than ${lastProductionVersion}; rollback releases are not supported.`,
    );
  }
  return { tag, version, idempotent: alreadyPublishedSha === checkoutSha };
}

const git = (root, args) => gitOutput(root, args, { stdio: ["ignore", "pipe", "pipe"] });

function isAncestor(root, ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** A release commit: one parent on main, differing from it only by the release version. */
export function isReleaseCommitOfMain(root, sha) {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1);
  if (parents.length !== 1 || !isAncestor(root, parents[0], "origin/main")) return false;
  try {
    verifyReleaseCommit(root, sha, parents[0]);
    return true;
  } catch {
    return false;
  }
}

function validateCheckout(root, tag) {
  const version = JSON.parse(readFileSync(resolve(root, "version.json"), "utf8")).version;
  const checkoutSha = git(root, ["rev-parse", "HEAD"]);
  const tagSha = git(root, ["rev-parse", `${tag}^{commit}`]);
  if (git(root, ["cat-file", "-t", `refs/tags/${tag}`]) !== "tag") {
    throw new Error(`Production candidate ${tag} must be an annotated tag.`);
  }
  if (git(root, ["status", "--porcelain"])) {
    throw new Error("Production checkout must be clean.");
  }
  if (!isAncestor(root, tagSha, "origin/main") && !isReleaseCommitOfMain(root, tagSha)) {
    throw new Error(`Tag ${tag} is neither in main history nor a release commit of a main revision.`);
  }
  return validateProductionRelease({
    tag,
    version,
    tagSha,
    checkoutSha,
    lastProductionVersion: process.env.XMATRIX_LAST_PRODUCTION_VERSION || PRODUCTION_BASELINE_VERSION,
    alreadyPublishedSha: process.env.XMATRIX_PUBLISHED_SHA || null,
  });
}

export function verifyRemoteProductionTag(root, tag, expectedSha) {
  productionVersionFromTag(tag);
  if (!/^[0-9a-f]{40}$/iu.test(expectedSha ?? "")) {
    throw new Error("Expected production SHA must be one full Git commit id.");
  }
  git(root, [
    "fetch",
    "--force",
    "origin",
    `+refs/tags/${tag}:refs/tags/${tag}`,
  ]);
  if (git(root, ["cat-file", "-t", `refs/tags/${tag}`]) !== "tag") {
    throw new Error(`Production candidate ${tag} must remain an annotated tag on origin.`);
  }
  const actualSha = git(root, ["rev-parse", `${tag}^{commit}`]);
  if (actualSha !== expectedSha) {
    throw new Error(
      `Remote production tag ${tag} resolves to ${actualSha}; expected immutable SHA ${expectedSha}.`,
    );
  }
  return { tag, sha: actualSha };
}

const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === "validate-checkout" && first) {
    const result = validateCheckout(process.cwd(), first);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "validate-candidate" && first && second) {
    const result = validateCandidateTag({
      version: first,
      candidateSha: second,
      existingTagSha: third || null,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "verify-remote-tag" && first && second) {
    const result = verifyRemoteProductionTag(process.cwd(), first, second);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    throw new Error(
      "Usage: production-release-policy.mjs validate-checkout <tag> | validate-candidate <version> <sha> [existing-sha] | verify-remote-tag <tag> <sha>",
    );
  }
}
