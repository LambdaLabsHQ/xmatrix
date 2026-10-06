import assert from "node:assert/strict";
import test from "node:test";

import { api, inflightRef, intentRef, nextVersion, normalizeScope, parseIntentRef, planTrain } from "./release-train.mjs";

const MAIN = "c".repeat(40);
const OLD = "a".repeat(40);
const NEWER = "f".repeat(40);
const ancestry = new Map([[OLD, [MAIN]], [MAIN, [MAIN]]]);
const isAncestor = (ancestor, descendant) => ancestry.get(ancestor)?.includes(descendant) ?? false;

function train({ refs, tags = [], states = {} }) {
  return planTrain({
    refs,
    trainSha: MAIN,
    isAncestor,
    tagExists: (tag) => tags.includes(tag),
    productionState: (tag) => states[tag] ?? "none",
  });
}

test("a scope is canonical, unique and keeps desktop with its cli", () => {
  assert.deepEqual(normalizeScope("web,hub"), ["hub", "web"]);
  assert.deepEqual(normalizeScope("all"), ["hub", "web", "cli", "desktop", "android", "ios"]);
  for (const bad of ["", "hub,hub", "desktop", "hub,server"]) {
    assert.throws(() => normalizeScope(bad), /desktop requires cli/u, bad);
  }
});

test("intent refs round-trip and reject anything else", () => {
  const open = intentRef("123", ["web", "hub"]);
  assert.equal(open, "refs/release-intents/123/hub+web");
  assert.deepEqual(parseIntentRef(open, OLD), { ref: open, sha: OLD, id: "123", scope: ["hub", "web"], state: "open" });
  const inflight = inflightRef("xmatrix-v0.16.470", "123", ["hub"]);
  assert.equal(inflight, "refs/release-inflight/xmatrix-v0.16.470/123/hub");
  assert.equal(parseIntentRef(inflight, OLD).tag, "xmatrix-v0.16.470");
  for (const bad of ["refs/release-intents/abc/hub", "refs/release-intents/1/web+hub", "refs/release-intents/1/desktop",
    "refs/release-inflight/v1/1/hub", "refs/heads/main"]) {
    assert.equal(parseIntentRef(bad, OLD), null, bad);
  }
});

test("a train ships the union of every open intent its revision contains", () => {
  const result = train({ refs: [
    { ref: "refs/release-intents/20/web", sha: OLD },
    { ref: "refs/release-intents/10/hub", sha: MAIN },
    { ref: "refs/release-intents/30/cli+desktop", sha: NEWER },
  ] });
  assert.deepEqual(result.eligible.map((intent) => intent.id), ["10", "20"]);
  assert.deepEqual(result.scope, ["hub", "web"], "an intent from after the freeze waits for the next train");
  assert.deepEqual(result.updates, []);
});

test("in-flight intents close on success, wait while deploying and reopen on failure", () => {
  const refs = [
    { ref: "refs/release-inflight/xmatrix-v0.16.1/1/hub", sha: OLD },
    { ref: "refs/release-inflight/xmatrix-v0.16.2/2/web", sha: OLD },
    { ref: "refs/release-inflight/xmatrix-v0.16.3/3/cli", sha: OLD },
    { ref: "refs/release-inflight/xmatrix-v0.16.4/4/android", sha: OLD },
  ];
  const result = train({
    refs,
    tags: ["xmatrix-v0.16.1", "xmatrix-v0.16.2", "xmatrix-v0.16.3"],
    states: { "xmatrix-v0.16.1": "success", "xmatrix-v0.16.2": "active", "xmatrix-v0.16.3": "failed" },
  });
  assert.deepEqual(result.updates, [
    { delete: "refs/release-inflight/xmatrix-v0.16.1/1/hub" },
    { delete: "refs/release-inflight/xmatrix-v0.16.3/3/cli" },
    { create: "refs/release-intents/3/cli", sha: OLD },
    { delete: "refs/release-inflight/xmatrix-v0.16.4/4/android" },
    { create: "refs/release-intents/4/android", sha: OLD },
  ]);
  assert.deepEqual(result.scope, ["cli", "android"], "a failed or never-tagged train's intents ride the next one");
});

test("a half-finished move keeps the in-flight copy only", () => {
  const result = train({ refs: [
    { ref: "refs/release-intents/5/hub", sha: OLD },
    { ref: "refs/release-inflight/xmatrix-v0.16.9/5/hub", sha: OLD },
  ], tags: ["xmatrix-v0.16.9"], states: { "xmatrix-v0.16.9": "active" } });
  assert.deepEqual(result.updates, [{ delete: "refs/release-intents/5/hub" }]);
  assert.deepEqual(result.eligible, []);
});

test("the version is the next patch above every release unless main already carries a higher one", () => {
  assert.equal(nextVersion({ tagNames: ["xmatrix-v0.16.469", "cli-v0.16.2"], mainVersion: "0.16.100" }), "0.16.470");
  assert.equal(nextVersion({ tagNames: ["xmatrix-v0.16.469"], mainVersion: "0.17.0" }), "0.17.0");
  assert.equal(nextVersion({ tagNames: [], mainVersion: "0.16.1" }), "0.16.1");
});

test("planner GitHub reads retry network failures and 5xx, not client errors", async () => {
  const realFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      if (calls === 2) return new Response("", { status: 502 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    assert.deepEqual(await api("/x", "token", { delayMs: 1 }), { ok: true });
    assert.equal(calls, 3);

    calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response("", { status: 404 }); };
    await assert.rejects(api("/x", "token", { delayMs: 1 }), /GitHub \/x: 404/);
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new TypeError("fetch failed"); };
    await assert.rejects(api("/x", "token", { attempts: 3, delayMs: 1 }), /GitHub \/x: fetch failed/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});
