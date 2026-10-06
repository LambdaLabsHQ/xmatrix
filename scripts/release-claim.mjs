#!/usr/bin/env node
// Atomic release-version claim.
//
// Two Production Release Requests for the same version must not both run
// their gates and only collide when tagging. The first thing a request does is
// claim its version: refs/release-claims/<tag> -> an annotated tag object that
// names the claiming run. Git's compare-and-swap push makes the claim atomic:
//
//   create:   --force-with-lease=<ref>:          succeeds only if the ref is absent
//   takeover: --force-with-lease=<ref>:<old-oid> succeeds only if it is unchanged
//
// A request whose version is held by a running request fails in seconds. A
// claim held by a run that already finished without tagging (failed or
// cancelled gates) is taken over, so a version can still be retried; two
// simultaneous takeovers resolve to exactly one winner.
import { gitOutput } from "./git-output.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TAG = /^xmatrix-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export function claimRef(tag) {
  if (!TAG.test(tag)) throw new Error(`Invalid release tag ${tag}`);
  return `refs/release-claims/${tag}`;
}

export function claimMessage(runId) {
  return `xmatrix release claim\nrun: ${runId}\n`;
}

/** Pure: the run id recorded in a claim tag object's `git cat-file -p` output. */
export function claimHolder(tagObjectText) {
  const match = /^run: (\d+)$/mu.exec(tagObjectText.split("\n\n").slice(1).join("\n\n"));
  return match ? match[1] : null;
}

/**
 * Pure: what to do about an existing claim. `holderRun` is the GitHub run the
 * claim names (null when unreadable or gone).
 */
export function claimDecision({ runId, holder, holderRun }) {
  if (holder === String(runId)) return { action: "keep" };
  if (holder && holderRun && holderRun.status !== "completed") {
    return { action: "refuse", reason: `release version is held by running request ${holderRun.html_url ?? holder}` };
  }
  return { action: "takeover" };
}

// Self-hosted runners carry no git identity; claims use the release commit's.
const RELEASE_IDENTITY = ["-c", "user.name=xMatrix Release", "-c", "user.email=release@xmatrix.sh"];

const git = (root, args) => gitOutput(root, args, { stdio: ["ignore", "pipe", "pipe"] });

function remoteClaim(root, ref) {
  const line = git(root, ["ls-remote", "origin", ref]);
  return line ? line.split(/\s+/u)[0] : null;
}

function casPush(root, object, ref, expected) {
  try {
    git(root, ["push", "--no-verify", `--force-with-lease=${ref}:${expected ?? ""}`, "origin", `${object}:${ref}`]);
    return true;
  } catch {
    return false;
  }
}

async function readRun(repository, runId, token) {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read claiming run ${runId}: ${response.status}`);
  return response.json();
}

/** Claim `tag` for `runId` at `sha`; throws when another running request holds it. */
export async function claimRelease({ root, tag, runId, sha, readHolderRun }) {
  const ref = claimRef(tag);
  const localTag = `refs/tags/release-claim-${runId}`;
  git(root, [...RELEASE_IDENTITY, "tag", "--force", "--annotate", "--message", claimMessage(runId), localTag.slice("refs/tags/".length), sha]);
  const object = git(root, ["rev-parse", localTag]);

  if (casPush(root, object, ref, null)) return { claimed: true };

  const current = remoteClaim(root, ref);
  if (!current) {
    // Released between our attempt and the read; one more atomic create decides.
    if (casPush(root, object, ref, null)) return { claimed: true };
    throw new Error(`Lost the race to claim ${tag}`);
  }
  git(root, ["fetch", "--no-tags", "origin", `+${ref}:refs/claim-probe`]);
  const holder = claimHolder(git(root, ["cat-file", "-p", current]));
  const decision = claimDecision({
    runId,
    holder,
    holderRun: holder ? await readHolderRun(holder) : null,
  });
  if (decision.action === "keep") return { claimed: true };
  if (decision.action === "refuse") throw new Error(`${tag}: ${decision.reason}`);
  if (casPush(root, object, ref, current)) return { claimed: true, tookOverFrom: holder };
  throw new Error(`Lost the race to take over the stale claim on ${tag}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, tag, runId, sha] = process.argv.slice(2);
  if (command !== "claim" || !tag || !/^\d+$/u.test(runId ?? "") || !/^[0-9a-f]{40}$/u.test(sha ?? "")) {
    console.error("Usage: node scripts/release-claim.mjs claim <tag> <run-id> <sha>");
    process.exit(2);
  }
  try {
    const result = await claimRelease({
      root: process.cwd(),
      tag,
      runId,
      sha,
      readHolderRun: (holder) => readRun(process.env.GITHUB_REPOSITORY, holder, process.env.GITHUB_TOKEN),
    });
    console.log(result.tookOverFrom
      ? `Claimed ${tag} for run ${runId}, taking over the finished run ${result.tookOverFrom}.`
      : `Claimed ${tag} for run ${runId}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
