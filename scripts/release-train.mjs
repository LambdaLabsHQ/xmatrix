#!/usr/bin/env node
// Batched production release train.
//
// A release request is an intent, not a train: the Production Release Intent
// workflow records `refs/release-intents/<run>/<scope>` at the main revision it
// was dispatched from, then wakes the train. The train (Production Release
// Request) is serialized repository-wide. Each train reconciles intents already
// in flight, freezes its own main revision, ships the union of every open
// intent that revision contains, and chooses the version itself. A train that
// GitHub displaces while pending loses nothing: the intents stay in refs and
// the next train takes them.
//
//   open:      refs/release-intents/<intent-run>/<scope>             -> main SHA
//   in flight: refs/release-inflight/<tag>/<intent-run>/<scope>      -> main SHA
//
// An in-flight intent closes when its tag's Production Release succeeds. It
// reopens when its train never tagged (a failed gate) or its production run
// failed, so the next train retries it; it waits while that run is active.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { claimRelease } from "./release-claim.mjs";
import { compareSemver, highestReleaseTag, parseSemver } from "./release-version-order.mjs";

export const COMPONENTS = Object.freeze(["hub", "web", "cli", "desktop", "android", "ios"]);
const OPEN_PREFIX = "refs/release-intents/";
const INFLIGHT_PREFIX = "refs/release-inflight/";
const TAG = /^xmatrix-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RUN_ID = /^[1-9]\d*$/u;

/** Canonical component list from `hub,web` or `all`; desktop requires cli. */
export function normalizeScope(requested) {
  const items = requested === "all" ? [...COMPONENTS] : String(requested ?? "").split(",");
  if (!items.length || items.some((item) => !COMPONENTS.includes(item)) || new Set(items).size !== items.length ||
      (items.includes("desktop") && !items.includes("cli"))) {
    throw new Error("release_components must name unique supported components; desktop requires cli");
  }
  return COMPONENTS.filter((item) => items.includes(item));
}

export function intentRef(runId, scope) {
  if (!RUN_ID.test(String(runId))) throw new Error(`Invalid intent run id ${runId}`);
  return `${OPEN_PREFIX}${runId}/${normalizeScope(scope.join(",")).join("+")}`;
}

export function inflightRef(tag, runId, scope) {
  if (!TAG.test(tag)) throw new Error(`Invalid release tag ${tag}`);
  return `${INFLIGHT_PREFIX}${tag}/${intentRef(runId, scope).slice(OPEN_PREFIX.length)}`;
}

/** An intent from a ref name, or null for anything that is not one. */
export function parseIntentRef(ref, sha) {
  const inflight = ref.startsWith(INFLIGHT_PREFIX);
  if (!inflight && !ref.startsWith(OPEN_PREFIX)) return null;
  const parts = ref.slice(inflight ? INFLIGHT_PREFIX.length : OPEN_PREFIX.length).split("/");
  const [tag, id, scopeText] = inflight ? parts : [undefined, ...parts];
  if (parts.length !== (inflight ? 3 : 2) || (inflight && !TAG.test(tag)) || !RUN_ID.test(id ?? "")) return null;
  let scope;
  try {
    scope = normalizeScope((scopeText ?? "").split("+").join(","));
  } catch {
    return null;
  }
  if (scope.join("+") !== scopeText) return null;
  return { ref, sha, id, scope, ...(inflight ? { tag, state: "inflight" } : { state: "open" }) };
}

/**
 * Pure: reconcile in-flight intents and choose what this train ships.
 * `productionState(tag)` is "success", "failed", "active" or "none" (no run).
 */
export function planTrain({ refs, trainSha, isAncestor, tagExists, productionState }) {
  const intents = refs.map(({ ref, sha }) => parseIntentRef(ref, sha)).filter(Boolean);
  const inflight = intents.filter((intent) => intent.state === "inflight");
  const inflightIds = new Set(inflight.map((intent) => intent.id));
  const updates = [];
  const open = [];

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
    } else {
      const reopened = intentRef(intent.id, intent.scope);
      updates.push({ delete: intent.ref }, { create: reopened, sha: intent.sha });
      open.push({ ...intent, ref: reopened, state: "open", tag: undefined });
    }
  }
  for (const intent of intents.filter((candidate) => candidate.state === "open")) {
    // A move to in flight that stopped half way: the in-flight copy is the one.
    if (inflightIds.has(intent.id)) updates.push({ delete: intent.ref });
    else open.push(intent);
  }

  const eligible = open.filter((intent) => isAncestor(intent.sha, trainSha))
    .sort((left, right) => Number(left.id) - Number(right.id));
  const selected = new Set(eligible.flatMap((intent) => intent.scope));
  return { updates, eligible, scope: COMPONENTS.filter((item) => selected.has(item)) };
}

/** Pure: the next version above every published release, or main's own higher version. */
export function nextVersion({ tagNames, mainVersion }) {
  const highest = highestReleaseTag(tagNames);
  let next = "0.0.1";
  if (highest) {
    const [major, minor, patch] = parseSemver(highest.version).core;
    next = `${major}.${minor}.${patch + 1n}`;
  }
  if (mainVersion && compareSemver(mainVersion, next) > 0) return mainVersion;
  return next;
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

function pushUpdates(root, updates) {
  if (!updates.length) return;
  const refspecs = updates.map((update) => update.delete ? `:${update.delete}` : `${update.sha}:${update.create}`);
  git(root, ["push", "--no-verify", "--atomic", "origin", ...refspecs]);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

async function plan(root) {
  const token = process.env.GITHUB_TOKEN;
  const trainSha = process.env.GITHUB_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const refs = lsRemote(root, [`${OPEN_PREFIX}*`, `${INFLIGHT_PREFIX}*`]);
  const tagNames = lsRemote(root, ["refs/tags/*"]).map(({ ref }) => ref.slice("refs/tags/".length));
  const productionStates = new Map();
  for (const tag of new Set(refs.map(({ ref, sha }) => parseIntentRef(ref, sha)?.tag).filter(Boolean))) {
    productionStates.set(tag, tagNames.includes(tag) ? await productionStateOf(tag, token) : "untagged");
  }
  const result = planTrain({
    refs,
    trainSha,
    isAncestor: isAncestorIn(root),
    tagExists: (tag) => tagNames.includes(tag),
    productionState: (tag) => productionStates.get(tag),
  });
  pushUpdates(root, result.updates);
  if (!result.eligible.length) {
    console.log("No open release intent is contained in this revision; nothing to release.");
    output("scope", "");
    return;
  }

  const mainVersion = JSON.parse(readFileSync(path.join(root, "version.json"), "utf8")).version;
  const version = nextVersion({ tagNames, mainVersion });
  const tag = `xmatrix-v${version}`;
  await claimRelease({
    root, tag, runId, sha: trainSha,
    readHolderRun: async (holder) => {
      try {
        return await api(`/actions/runs/${holder}`, token);
      } catch {
        return null;
      }
    },
  });
  pushUpdates(root, result.eligible.flatMap((intent) => [
    { create: inflightRef(tag, intent.id, intent.scope), sha: intent.sha },
    { delete: intent.ref },
  ]));
  console.log(`Train ${tag} ships ${result.scope.join(",")} for intents ${result.eligible.map((intent) => intent.id).join(", ")}.`);
  output("scope", result.scope.join(","));
  output("version", version);
  output("tag", tag);
  output("intents", result.eligible.map((intent) => intent.id).join(","));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === "plan") await plan(process.cwd());
    else if (command === "intent-ref") console.log(intentRef(rest[0], normalizeScope(rest[1])));
    else {
      console.error("Usage: node scripts/release-train.mjs <plan|intent-ref <run-id> <components>>");
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
