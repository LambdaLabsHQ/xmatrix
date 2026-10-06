#!/usr/bin/env node
// A release is cut from a frozen main SHA without a version-bump commit on
// main: the Production Release Request stamps the release version onto that
// SHA as a single child commit (the release commit) and tests, tags and ships
// exactly that commit.
//
// Everything downstream that proves "the request authorized this deploy" —
// production preflight, the Hub and Web deploys, the main-history check —
// accepts the deployed SHA when it is the request's own SHA, or its release
// commit: one parent, that SHA, and identical content apart from the release
// version (the CI ledger's content key, so the rule is defined in one place).
import { gitOutput } from "./git-output.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { currentLedgerKey } from "./ci-ledger.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;

/** Pure: why `deploySha` is not `sourceSha` or its release commit, or null. */
export function releaseCommitProblem({ deploySha, sourceSha, parents, deployKey, sourceKey }) {
  if (!FULL_SHA.test(deploySha ?? "") || !FULL_SHA.test(sourceSha ?? "")) {
    return "release and source must be full commit SHAs";
  }
  if (deploySha === sourceSha) return null;
  if (parents.length !== 1 || parents[0] !== sourceSha) {
    return `${deploySha} is not a release commit of ${sourceSha}: its parents are ${parents.join(",") || "none"}`;
  }
  if (deployKey !== sourceKey) {
    return `${deploySha} changes more than the release version of ${sourceSha}`;
  }
  return null;
}

const git = (root, args) => gitOutput(root, args, { stdio: ["ignore", "pipe", "pipe"] });

function hasCommit(root, sha) {
  try {
    git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Throws unless `deploySha` is `sourceSha` or its release commit. */
export function verifyReleaseCommit(root, deploySha, sourceSha) {
  for (const sha of [deploySha, sourceSha]) {
    if (FULL_SHA.test(sha ?? "") && !hasCommit(root, sha)) {
      git(root, ["fetch", "--no-tags", "--depth=2", "origin", sha]);
    }
  }
  const same = deploySha === sourceSha;
  const problem = releaseCommitProblem({
    deploySha,
    sourceSha,
    parents: same ? [] : git(root, ["rev-list", "--parents", "-n", "1", deploySha]).split(" ").slice(1),
    deployKey: same ? "" : currentLedgerKey(deploySha, root),
    sourceKey: same ? "" : currentLedgerKey(sourceSha, root),
  });
  if (problem) throw new Error(problem);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, deploySha, sourceSha] = process.argv.slice(2);
  if (command !== "verify" || !deploySha || !sourceSha) {
    console.error("Usage: node scripts/release-commit.mjs verify <deploy-sha> <source-sha>");
    process.exit(2);
  }
  try {
    verifyReleaseCommit(process.cwd(), deploySha, sourceSha);
    console.log(deploySha === sourceSha
      ? `${deploySha} is the authorized source revision.`
      : `${deploySha} is the release commit of ${sourceSha}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
