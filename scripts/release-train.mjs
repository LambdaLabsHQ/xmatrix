#!/usr/bin/env node
// Batched production release train.
//
// A release request is an intent, not a train: the Production Release Intent
// workflow records it in a ref and wakes the train. The train (Production
// Release Request) is serialized repository-wide and chooses the version
// itself. A train that GitHub displaces while pending loses nothing: the
// intents stay in refs and the next train takes them.
//
// Releases come in two channels, and the version alone says which one
// (release-version-order.mjs):
//
//   beta    X.Y.Z-beta.N  Any Agent asks for one after merging. A beta train
//                         freezes its own main revision and ships the union of
//                         every open beta intent that revision contains: Hub
//                         and Web to production, clients to their dev channel
//                         and TestFlight. X.Y.Z is the patch after the last
//                         stable, unless main or an earlier beta names a
//                         higher one.
//   stable  X.Y.Z         The stable release Agent asks for one with a beta it
//                         verified and the patch, minor or major bump its
//                         changes call for. The train rebuilds exactly that
//                         beta's source at the stable version and ships only
//                         the clients named, to their stable channel and App
//                         Review; Hub and Web already run every beta. It never
//                         rides with betas, never takes newer main content and
//                         never moves a stable source back.
//
//   open beta:   refs/release-intents/<intent-run>/<scope>                         -> main SHA
//   open stable: refs/release-intents/<intent-run>/<scope>/<bump>/<beta tag>       -> beta commit
//   in flight:   refs/release-inflight/<tag>/<intent-run>/<scope>[/<bump>/<beta tag>] -> intent SHA
//
// An in-flight ref keeps its intent's stable suffix, so a train knows a stable
// as one before any tag exists; an in-flight ref without it is a beta, or a
// release cut before channels existed, which reconciles like one.
//
// An in-flight intent closes when its tag's Production Release succeeds and
// waits while that run is active. A beta reopens when its train never tagged
// or its production run failed, so the next train retries it. A stable is
// never retried by a new train: one that never tagged changed nothing and
// closes; one whose production run failed stays in flight, pending recovery of
// that same run, until it succeeds or a later successful stable ships every
// component it names.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { claimRelease } from "./release-claim.mjs";
import { releaseCommitProblemAt } from "./release-commit.mjs";
import { authoredReleaseNotes } from "./release-notes.mjs";
import {
  compareSemver,
  parseSemver,
  RELEASE_TAG_PATTERN,
  releaseChannel,
  releaseCore,
} from "./release-version-order.mjs";

export const COMPONENTS = Object.freeze(["hub", "web", "cli", "desktop", "android", "ios"]);
// Hub and Web are single production services that every beta deploys.
export const STABLE_COMPONENTS = Object.freeze(["cli", "desktop", "android", "ios"]);
export const BUMPS = Object.freeze(["patch", "minor", "major"]);
const OPEN_PREFIX = "refs/release-intents/";
const INFLIGHT_PREFIX = "refs/release-inflight/";
const RUN_ID = /^[1-9]\d*$/u;
const RELEASE_TAG_PREFIX = /^(?:cli|desktop|android|xmatrix)-v/u;

/**
 * Canonical component list from `hub,web` or `all`; desktop requires cli. A
 * stable release names clients only, and `all` means every client.
 */
export function normalizeScope(requested, channel = "beta") {
  const allowed = channel === "stable" ? STABLE_COMPONENTS : COMPONENTS;
  const items = requested === "all" ? [...allowed] : String(requested ?? "").split(",");
  if (!items.length || items.some((item) => !allowed.includes(item)) || new Set(items).size !== items.length ||
      (items.includes("desktop") && !items.includes("cli"))) {
    throw new Error(channel === "stable"
      ? "a stable release names unique clients (cli, desktop, android, ios); hub and web ship with every beta; desktop requires cli"
      : "release_components must name unique supported components; desktop requires cli");
  }
  return COMPONENTS.filter((item) => items.includes(item));
}

function isBetaTag(tag) {
  return RELEASE_TAG_PATTERN.test(tag ?? "") && releaseChannel(tag.slice("xmatrix-v".length)) === "beta";
}

/** The open intent ref; a stable one also names its bump and the beta it releases. */
export function intentRef(runId, scope, stable = null) {
  if (!RUN_ID.test(String(runId))) throw new Error(`Invalid intent run id ${runId}`);
  const ref = `${OPEN_PREFIX}${runId}/${normalizeScope(scope.join(","), stable ? "stable" : "beta").join("+")}`;
  if (!stable) return ref;
  if (!BUMPS.includes(stable.bump)) throw new Error(`bump must be one of ${BUMPS.join(", ")}`);
  if (!isBetaTag(stable.candidate)) {
    throw new Error(`A stable release ships a verified beta tag xmatrix-vX.Y.Z-beta.N, not '${stable.candidate}'`);
  }
  return `${ref}/${stable.bump}/${stable.candidate}`;
}

export function inflightRef(tag, runId, scope, stable = null) {
  if (!RELEASE_TAG_PATTERN.test(tag)) throw new Error(`Invalid release tag ${tag}`);
  if (stable && releaseChannel(tag.slice("xmatrix-v".length)) !== "stable") {
    throw new Error(`Stable intent cannot ship as ${tag}`);
  }
  return `${INFLIGHT_PREFIX}${tag}/${intentRef(runId, scope, stable).slice(OPEN_PREFIX.length)}`;
}

/** An intent from a ref name, or null for anything that is not one. */
export function parseIntentRef(ref, sha) {
  const inflight = ref.startsWith(INFLIGHT_PREFIX);
  if (!inflight && !ref.startsWith(OPEN_PREFIX)) return null;
  const parts = ref.slice(inflight ? INFLIGHT_PREFIX.length : OPEN_PREFIX.length).split("/");
  const tag = inflight ? parts.shift() : undefined;
  if (parts.length !== 2 && parts.length !== 4) return null;
  const [id, scopeText, bump, candidate] = parts;
  if ((inflight && (!RELEASE_TAG_PATTERN.test(tag) ||
      (candidate !== undefined && releaseChannel(tag.slice("xmatrix-v".length)) !== "stable"))) ||
      !RUN_ID.test(id) || (candidate !== undefined && (!BUMPS.includes(bump) || !isBetaTag(candidate)))) return null;
  let scope;
  try {
    scope = normalizeScope(scopeText.split("+").join(","), candidate === undefined ? "beta" : "stable");
  } catch {
    return null;
  }
  if (scope.join("+") !== scopeText) return null;
  return {
    ref, sha, id, scope, ...(inflight ? { tag, state: "inflight" } : { state: "open" }),
    ...(candidate === undefined ? {} : { stable: { bump, candidate } }),
  };
}

const byId = (left, right) => Number(left.id) - Number(right.id);

/** Whether a later successful stable shipped every component a pending one names. */
function superseded(stables, intent) {
  const version = intent.tag.slice("xmatrix-v".length);
  return stables.some((stable) => compareSemver(stable.tag.slice("xmatrix-v".length), version) > 0 &&
    intent.scope.every((component) => stable.scope.includes(component)));
}

/**
 * Pure: reconcile in-flight intents and choose what this train may ship.
 * `productionState(tag)` is "success", "failed", "active" or "none" (no run).
 * `stables` lists successful stable releases as { tag, scope }.
 *
 * Open stable intents come back in `stable`, oldest first: the caller checks
 * each against its evidence (checkStable) and ships the first that holds, alone.
 * Otherwise the train ships `scope`, the union of the `eligible` betas.
 */
export function planTrain({ refs, trainSha, isAncestor, tagExists, productionState, stables = [] }) {
  const intents = refs.map(({ ref, sha }) => parseIntentRef(ref, sha)).filter(Boolean);
  const inflight = intents.filter((intent) => intent.state === "inflight");
  const inflightIds = new Set(inflight.map((intent) => intent.id));
  const updates = [];
  const open = [];
  const pending = [];

  const stateByTag = new Map();
  for (const intent of inflight) {
    if (!stateByTag.has(intent.tag)) {
      stateByTag.set(intent.tag, tagExists(intent.tag) ? productionState(intent.tag) : "untagged");
    }
    const state = stateByTag.get(intent.tag);
    if (state === "success") {
      updates.push({ delete: intent.ref });
    } else if (state === "active") {
      // Its production run is still deploying; the next train reconciles it.
    } else if (!intent.stable) {
      const reopened = intentRef(intent.id, intent.scope);
      updates.push({ delete: intent.ref }, { create: reopened, sha: intent.sha });
      open.push({ ...intent, ref: reopened, state: "open", tag: undefined });
    } else if (state === "untagged" || superseded(stables, intent)) {
      // A stable that never tagged changed nothing, so that decision is over;
      // one a later successful stable fully covers was recovered by it.
      updates.push({ delete: intent.ref });
    } else {
      // Tagged, then its production run failed: recover that same run.
      pending.push(intent);
    }
  }
  for (const intent of intents.filter((candidate) => candidate.state === "open")) {
    // A move to in flight that stopped half way: the in-flight copy is the one.
    if (inflightIds.has(intent.id)) updates.push({ delete: intent.ref });
    else open.push(intent);
  }

  const stable = open.filter((intent) => intent.stable).sort(byId);
  const eligible = open.filter((intent) => !intent.stable && isAncestor(intent.sha, trainSha)).sort(byId);
  const selected = new Set(eligible.flatMap((intent) => intent.scope));
  return { updates, pending, stable, eligible, scope: COMPONENTS.filter((item) => selected.has(item)) };
}

/** Pure: `version` raised by a patch, minor or major bump. */
export function bumpVersion(version, bump) {
  const [major, minor, patch] = parseSemver(version).core;
  if (bump === "major") return `${major + 1n}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1n}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1n}`;
  throw new Error(`bump must be one of ${BUMPS.join(", ")}`);
}

/** Every release version the tags name, highest first. */
function releaseVersions(tagNames) {
  const versions = [];
  for (const tag of tagNames) {
    if (!RELEASE_TAG_PREFIX.test(tag)) continue;
    const version = tag.replace(RELEASE_TAG_PREFIX, "");
    try {
      releaseChannel(version);
    } catch {
      continue;
    }
    versions.push(version);
  }
  return versions.sort((left, right) => compareSemver(right, left));
}

const isStable = (version) => releaseChannel(version) === "stable";

/**
 * Pure: the next beta. Its X.Y.Z is the patch after the highest stable, unless
 * main's version.json or an earlier beta already names a higher one (planning
 * a minor or major); N counts that X.Y.Z's betas.
 */
export function nextBetaVersion({ tagNames, mainVersion }) {
  const versions = releaseVersions(tagNames);
  const highestStable = versions.find(isStable);
  let core = highestStable ? bumpVersion(highestStable, "patch") : "0.0.1";
  for (const version of [mainVersion, ...versions.filter((item) => !isStable(item))]) {
    let planned;
    try {
      planned = releaseCore(version);
    } catch {
      continue;
    }
    if (compareSemver(planned, core) > 0) core = planned;
  }
  const latest = versions.find((version) => !isStable(version) && releaseCore(version) === core);
  return `${core}-beta.${latest ? Number(latest.split("-beta.")[1]) + 1 : 1}`;
}

/**
 * Pure: the version a verified beta ships as: the last stable raised by
 * `bump`. It must reach the beta's own X.Y.Z, so the beta precedes it, and be
 * newer than every release, so versions only ever go up.
 */
export function stableVersion({ tagNames, candidate, bump }) {
  const versions = releaseVersions(tagNames);
  const core = releaseCore(candidate.slice("xmatrix-v".length));
  const highestStable = versions.find(isStable);
  const version = highestStable ? bumpVersion(highestStable, bump) : core;
  if (compareSemver(version, core) < 0) {
    throw new Error(`A ${bump} bump of ${highestStable} is ${version}, which does not reach ${candidate}; choose a larger bump`);
  }
  if (versions.length && compareSemver(version, versions[0]) <= 0) {
    throw new Error(`${version} must be newer than every release, and ${versions[0]} exists`);
  }
  return version;
}

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function lsRemote(root, patterns) {
  const text = git(root, ["ls-remote", "origin", ...patterns]);
  return text ? text.split("\n").map((line) => {
    const [sha, ref] = line.split(/\s+/u);
    return { sha, ref };
  }).filter(({ ref }) => !ref.endsWith("^{}")) : [];
}

function isAncestorIn(root) {
  return (ancestor, descendant) => {
    try {
      git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * A release tag's commit and the facts its train recorded in the annotation:
 * the components it shipped, the main revision it was cut from and, for a
 * stable, its channel. Tags cut before channels existed record none of them.
 */
export function tagRecord(root, tag) {
  git(root, ["fetch", "--no-tags", "--force", "origin", `+refs/tags/${tag}:refs/tags/${tag}`]);
  const message = git(root, ["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`]);
  const field = (name) => new RegExp(`^${name}: (\\S+)$`, "mu").exec(message)?.[1] ?? null;
  return {
    commit: git(root, ["rev-parse", `refs/tags/${tag}^{commit}`]),
    scope: (field("scope") ?? "").split(",").filter(Boolean),
    source: field("source"),
    channel: field("channel"),
  };
}

/** The main revision a release commit was cut from (or the commit, when main carried its version). */
function sourceOf(root, commit, mainSha) {
  const isAncestor = isAncestorIn(root);
  if (isAncestor(commit, mainSha)) return commit;
  const parents = git(root, ["rev-list", "--parents", "-n", "1", commit]).split(" ").slice(1);
  if (parents.length === 1 && isAncestor(parents[0], mainSha) && releaseCommitProblemAt(root, commit, parents[0]) === null) {
    return parents[0];
  }
  throw new Error(`${commit} is neither a main revision nor a release commit of one`);
}

/** A read of the GitHub API, retried through runner network failures and 5xx. */
export async function api(pathname, token, { attempts = 5, delayMs = 2_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${pathname}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
    } catch (error) {
      if (attempt >= attempts) throw new Error(`GitHub ${pathname}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      continue;
    }
    if (response.ok) return response.json();
    if (response.status < 500 || attempt >= attempts) throw new Error(`GitHub ${pathname}: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
  }
}

/** "success", "failed", "active" or "none" for the latest Production Release of `tag`. */
async function productionStateOf(tag, token) {
  const { workflow_runs: runs } = await api(
    `/actions/workflows/production-release.yml/runs?branch=${encodeURIComponent(tag)}&event=workflow_dispatch&per_page=20`, token);
  const latest = [...runs].sort((left, right) => right.id - left.id)[0];
  if (!latest) return "none";
  if (latest.status !== "completed") return "active";
  return latest.conclusion === "success" ? "success" : "failed";
}

/**
 * Whether a stable intent may ship, and as what. The candidate must be the
 * immutable beta tag the intent recorded, delivered by a successful Production
 * Release that shipped every component asked for, and its source must contain
 * the last stable's source, so no component's stable ever moves back.
 */
export async function checkStable(root, { candidate, bump, scope, sha }, { tagNames, mainSha, productionState }) {
  if (!isBetaTag(candidate) || !tagNames.includes(candidate)) {
    throw new Error(`${candidate} is not a published beta tag`);
  }
  const record = tagRecord(root, candidate);
  if (sha && record.commit !== sha) throw new Error(`${candidate} no longer points at ${sha}`);
  const state = await productionState(candidate);
  if (state !== "success") throw new Error(`${candidate}'s Production Release is ${state}, not success`);
  const missing = scope.filter((component) => !record.scope.includes(component));
  if (missing.length) {
    throw new Error(`${candidate} did not ship ${missing.join(",")}; verify a beta that did`);
  }
  const version = stableVersion({ tagNames, candidate, bump });
  const sourceSha = sourceOf(root, record.commit, mainSha);
  const previous = releaseVersions(tagNames).find(isStable);
  if (previous) {
    const previousSource = sourceOf(root, tagRecord(root, `xmatrix-v${previous}`).commit, mainSha);
    if (!isAncestorIn(root)(previousSource, sourceSha)) {
      throw new Error(`${candidate} was cut from ${sourceSha}, which does not contain ${previousSource}, the source of ` +
        `stable ${previous}; a stable never moves back`);
    }
  }
  authoredReleaseNotes(root, version, sourceSha);
  return { version, tag: `xmatrix-v${version}`, sourceSha, commit: record.commit };
}

function pushUpdates(root, updates) {
  if (!updates.length) return;
  const refspecs = updates.map((update) => update.delete ? `:${update.delete}` : `${update.sha}:${update.create}`);
  git(root, ["push", "--no-verify", "--atomic", "origin", ...refspecs]);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

async function claimAndShip(root, { tag, version, channel, sourceSha, runId, intents, scope, token }) {
  await claimRelease({
    root, tag, runId, sha: sourceSha,
    readHolderRun: async (holder) => {
      try {
        return await api(`/actions/runs/${holder}`, token);
      } catch {
        return null;
      }
    },
  });
  pushUpdates(root, intents.flatMap((intent) => [
    { create: inflightRef(tag, intent.id, intent.scope, intent.stable), sha: intent.sha },
    { delete: intent.ref },
  ]));
  console.log(`Train ${tag} ships ${scope.join(",")} (${channel}) for intents ${intents.map((intent) => intent.id).join(", ")}.`);
  output("scope", scope.join(","));
  output("version", version);
  output("tag", tag);
  output("channel", channel);
  output("source_sha", sourceSha);
  output("intents", intents.map((intent) => intent.id).join(","));
}

async function plan(root) {
  const token = process.env.GITHUB_TOKEN;
  const trainSha = process.env.GITHUB_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const refs = lsRemote(root, [`${OPEN_PREFIX}*`, `${INFLIGHT_PREFIX}*`]);
  const tagNames = lsRemote(root, ["refs/tags/*"]).map(({ ref }) => ref.slice("refs/tags/".length));
  const productionStates = new Map();
  const productionState = async (tag) => {
    if (!productionStates.has(tag)) {
      productionStates.set(tag, tagNames.includes(tag) ? await productionStateOf(tag, token) : "untagged");
    }
    return productionStates.get(tag);
  };
  const inflight = refs.map(({ ref, sha }) => parseIntentRef(ref, sha)).filter((intent) => intent?.state === "inflight");
  for (const intent of inflight) await productionState(intent.tag);
  // Later successful stables, to settle a failed stable they shipped over.
  const stables = [];
  const oldestPending = inflight.filter((intent) => intent.stable && tagNames.includes(intent.tag) &&
    !["success", "active"].includes(productionStates.get(intent.tag)))
    .map((intent) => intent.tag.slice("xmatrix-v".length)).sort(compareSemver)[0];
  if (oldestPending) {
    for (const version of releaseVersions(tagNames)) {
      if (!isStable(version) || compareSemver(version, oldestPending) <= 0) continue;
      const tag = `xmatrix-v${version}`;
      const record = tagRecord(root, tag);
      if (record.channel === "stable" && await productionState(tag) === "success") stables.push({ tag, scope: record.scope });
    }
  }
  const result = planTrain({
    refs,
    trainSha,
    isAncestor: isAncestorIn(root),
    tagExists: (tag) => tagNames.includes(tag),
    productionState: (tag) => productionStates.get(tag),
    stables,
  });
  pushUpdates(root, result.updates);
  for (const intent of result.pending) {
    console.log(`::warning::Stable ${intent.tag} (${intent.scope.join(",")}) is pending recovery: ` +
      "re-run the failed jobs of its Production Release.");
  }

  for (const intent of result.stable) {
    let stable;
    try {
      stable = await checkStable(root, { ...intent.stable, scope: intent.scope, sha: intent.sha },
        { tagNames, mainSha: trainSha, productionState });
    } catch (error) {
      console.log(`::error::Stable intent ${intent.id} for ${intent.stable.candidate} refused: ${error.message}`);
      pushUpdates(root, [{ delete: intent.ref }]);
      continue;
    }
    await claimAndShip(root, { ...stable, channel: "stable", runId, intents: [intent], scope: intent.scope, token });
    // A stable train ships alone; the betas it left open get a train of their own.
    output("betas_waiting", result.eligible.length ? "true" : "false");
    return;
  }

  if (!result.eligible.length) {
    console.log("No open release intent is contained in this revision; nothing to release.");
    output("scope", "");
    return;
  }
  const mainVersion = JSON.parse(readFileSync(path.join(root, "version.json"), "utf8")).version;
  const version = nextBetaVersion({ tagNames, mainVersion });
  await claimAndShip(root, {
    tag: `xmatrix-v${version}`, version, channel: "beta", sourceSha: trainSha, runId,
    intents: result.eligible, scope: result.scope, token,
  });
}

/**
 * The ref and SHA of a new intent, for the Production Release Intent workflow.
 * A stable intent is checked against its evidence now, so a refusal reaches
 * the stable release Agent at once; the train checks it again before shipping.
 */
async function intent(root, { runId, channel, components, candidate, bump }) {
  const mainSha = process.env.GITHUB_SHA;
  if (channel === "beta") {
    if (candidate || bump) throw new Error("candidate and bump belong to a stable release");
    output("ref", intentRef(runId, normalizeScope(components)));
    output("sha", mainSha);
    return;
  }
  if (channel !== "stable") throw new Error("channel must be beta or stable");
  const scope = normalizeScope(components, "stable");
  const ref = intentRef(runId, scope, { bump, candidate });
  const tagNames = lsRemote(root, ["refs/tags/*"]).map(({ ref: name }) => name.slice("refs/tags/".length));
  const stable = await checkStable(root, { candidate, bump, scope }, {
    tagNames, mainSha, productionState: (tag) => productionStateOf(tag, process.env.GITHUB_TOKEN),
  });
  console.log(`${candidate} can ship as stable ${stable.version} (${scope.join(",")}) from ${stable.sourceSha}.`);
  output("ref", ref);
  output("sha", stable.commit);
  output("version", stable.version);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "plan") await plan(process.cwd());
    else if (command === "intent") {
      const [runId, channel, components, candidate = "", bump = ""] = rest;
      await intent(process.cwd(), { runId, channel, components, candidate, bump });
    } else {
      console.error("Usage: node scripts/release-train.mjs <plan|intent <run-id> <beta|stable> <components> [candidate bump]>");
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
