#!/usr/bin/env node
// A release is cut from a frozen main SHA without a version-bump commit on
// main: the Production Release Request stamps the release version onto that
// SHA as a single child commit (the release commit) and tests, tags and ships
// exactly that commit.
//
// Everything downstream that proves "the request authorized this deploy" —
// production preflight, the Hub and Web deploys, the main-history check —
// accepts the deployed SHA when it is the request's own SHA, or its release
// commit: one parent, that SHA, and a tree that differs from it only in
// versioned files, each byte-identical to `stampVersionText` of the parent's
// file at the release version. The check re-derives the stamp rather than
// comparing normalized hashes, so nothing besides the stamp can pass.
import { execFileSync } from "node:child_process";

import { gitOutput } from "./git-output.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertSemver } from "./release-version-order.mjs";
import { stampVersionText, versionedPaths } from "./version.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;

/**
 * Pure: why `deploySha` is not `sourceSha` or its release commit, or null.
 * `changes` lists every path whose entry differs between the two trees, with
 * both sides' mode and text (null when the path is absent on that side).
 */
export function releaseCommitProblem({ deploySha, sourceSha, parents, version, changes }) {
  if (!FULL_SHA.test(deploySha ?? "") || !FULL_SHA.test(sourceSha ?? "")) {
    return "release and source must be full commit SHAs";
  }
  if (deploySha === sourceSha) return null;
  if (parents.length !== 1 || parents[0] !== sourceSha) {
    return `${deploySha} is not a release commit of ${sourceSha}: its parents are ${parents.join(",") || "none"}`;
  }
  const notStamp = (detail) => `${deploySha} changes more than the release version of ${sourceSha}: ${detail}`;
  for (const change of changes) {
    if (!versionedPaths.includes(change.file)) return notStamp(`${change.file} is not a versioned file`);
    if (change.source === null || change.deploy === null) return notStamp(`${change.file} was added or removed`);
    if (change.sourceMode !== change.deployMode) return notStamp(`${change.file} changed mode`);
    let stamped;
    try {
      stamped = stampVersionText(change.file, change.source, version);
    } catch (error) {
      return notStamp(`${change.file} cannot be stamped (${error instanceof Error ? error.message : error})`);
    }
    if (change.deploy !== stamped) return notStamp(`${change.file} is not the ${version} stamp of its source`);
  }
  return null;
}

const git = (root, args) => gitOutput(root, args, { stdio: ["ignore", "pipe", "pipe"] });
// File contents are compared exactly, so they are read untrimmed.
const gitRaw = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });

function hasCommit(root, sha) {
  try {
    git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Every path whose tree entry differs between `from` and `to`, with both sides. */
function treeChanges(root, from, to) {
  const raw = gitRaw(root, ["diff-tree", "-r", "-z", "--no-renames", from, to]);
  const fields = raw.split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    // ":<src mode> <dst mode> <src blob> <dst blob> <status>" then the path.
    const [sourceMode, deployMode, sourceBlob, deployBlob] = fields[index].slice(1).split(" ");
    const absent = /^0+$/u;
    const read = (blob) => (absent.test(blob) ? null : gitRaw(root, ["cat-file", "blob", blob]));
    changes.push({
      file: fields[index + 1],
      sourceMode,
      deployMode,
      source: read(sourceBlob),
      deploy: read(deployBlob),
    });
  }
  return changes;
}

/** Why `deploySha` is not `sourceSha` or its release commit, or null. */
export function releaseCommitProblemAt(root, deploySha, sourceSha) {
  for (const sha of [deploySha, sourceSha]) {
    if (FULL_SHA.test(sha ?? "") && !hasCommit(root, sha)) {
      git(root, ["fetch", "--no-tags", "--depth=2", "origin", sha]);
    }
  }
  if (deploySha === sourceSha || !FULL_SHA.test(deploySha ?? "") || !FULL_SHA.test(sourceSha ?? "")) {
    return releaseCommitProblem({ deploySha, sourceSha, parents: [], version: null, changes: [] });
  }
  const version = JSON.parse(gitRaw(root, ["show", `${deploySha}:version.json`])).version;
  assertSemver(version);
  return releaseCommitProblem({
    deploySha,
    sourceSha,
    parents: git(root, ["rev-list", "--parents", "-n", "1", deploySha]).split(" ").slice(1),
    version,
    changes: treeChanges(root, sourceSha, deploySha),
  });
}

/** Throws unless `deploySha` is `sourceSha` or its release commit. */
export function verifyReleaseCommit(root, deploySha, sourceSha) {
  const problem = releaseCommitProblemAt(root, deploySha, sourceSha);
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
