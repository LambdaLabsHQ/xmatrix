import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  DEPENDS_ON, deferWaitingIntents, HOLD_MINUTES, releaseGroup, releaseMinutes, waitsFor,
} from "./release-dependencies.mjs";
import { COMPONENTS, normalizeScope } from "./release-train.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (file) => parse(fs.readFileSync(path.join(rootDir, ".github/workflows", file), "utf8"));

// Every scope a beta or stable train can ship.
const scopes = [];
for (let mask = 1; mask < 1 << COMPONENTS.length; mask += 1) {
  const items = COMPONENTS.filter((_, index) => mask & (1 << index));
  try {
    scopes.push(normalizeScope(items.join(",")).join(","));
  } catch {
    // desktop without cli is not a scope
  }
}

test("every component has its dependencies and a duration, in the train's order", () => {
  assert.deepEqual(Object.keys(DEPENDS_ON), [...COMPONENTS]);
  for (const [component, needs] of Object.entries(DEPENDS_ON)) {
    for (const need of needs) assert.ok(COMPONENTS.includes(need) && need !== component, component);
    assert.ok(releaseMinutes(component) > 0, component);
  }
});

test("a release waits for one that ships the same component", () => {
  for (const component of COMPONENTS) assert.equal(waitsFor(component, component), true, component);
  assert.equal(waitsFor("hub,web", "web,cli"), true);
});

test("a release waits for one that ships what it depends on, never the other way", () => {
  for (const train of ["web", "cli", "android", "ios", "cli,desktop"]) assert.equal(waitsFor(train, "hub"), true, train);
  assert.equal(waitsFor("cli,desktop", "cli"), true, "Desktop bundles the CLI");
  // The apps are shells around the live Web, which they publish after.
  for (const train of ["android", "ios", "cli,desktop"]) assert.equal(waitsFor(train, "web"), true, train);
  for (const active of ["web", "cli", "android", "ios", "cli,desktop"]) {
    assert.equal(waitsFor("hub", active), false, `the Hub does not wait for ${active}`);
  }
  for (const active of ["cli", "android", "ios", "cli,desktop"]) {
    assert.equal(waitsFor("web", active), false, `the Web does not wait for ${active}`);
  }
});

test("releases that share nothing and need nothing of each other deploy side by side", () => {
  for (const [train, active] of [["web", "cli"], ["cli", "web"], ["android", "ios"], ["ios", "cli,desktop"],
    ["web", "android,ios"], ["cli", "android"], ["hub", "cli,desktop,android,ios"]]) {
    assert.equal(waitsFor(train, active), false, `${train} beside ${active}`);
  }
});

test("a scope that cannot be read waits and is waited for", () => {
  for (const unknown of ["", "server", "hub,server", undefined]) {
    for (const scope of scopes) {
      assert.equal(waitsFor(scope, unknown), true, `${scope} behind ${unknown}`);
      assert.equal(waitsFor(unknown, scope), true, `${unknown} behind ${scope}`);
    }
  }
});

test("two releases share a concurrency group only when each waits for the other", () => {
  // GitHub keeps one pending run per group and cancels the older one, so two
  // releases dispatched without waiting for each other must use different
  // groups, and Recovery must hold the group of every Hub release. Releases
  // of one component share a group, which backs up dispatch's wait.
  const { concurrency } = workflow("production-release.yml");
  const expression = concurrency.group.match(/\$\{\{\s*([\s\S]*?)\s*\}\}/u)[1];
  const evaluate = new Function("inputs", "contains", "format", `return (${expression});`);
  const group = (scope) => evaluate(
    { release_scope: scope },
    (value, search) => value.includes(search),
    (template, ...values) => template.replace(/\{(\d+)\}/gu, (_, index) => values[Number(index)]),
  );
  assert.equal(concurrency["cancel-in-progress"], false);
  const recovery = workflow("production-release-recovery.yml").jobs.unlock.concurrency.group;
  for (const scope of scopes) {
    assert.equal(group(scope), releaseGroup(scope), scope);
    if (scope.split(",").includes("hub")) assert.equal(group(scope), recovery, scope);
    for (const later of scopes) {
      if (group(later) === group(scope)) {
        assert.ok(waitsFor(later, scope) && waitsFor(scope, later), `${later} shares a group with ${scope}`);
      }
    }
  }
  for (const component of COMPONENTS.filter((item) => item !== "desktop")) {
    assert.equal(group(component), releaseGroup(component), component);
  }
  assert.equal(releaseGroup(""), recovery, "a scope that cannot be read holds the Hub's group");
});

test("planning holds the train only for a release that finishes soon", () => {
  const now = Date.parse("2026-10-25T10:00:00Z");
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const intents = [{ id: "1", scope: ["web"] }, { id: "2", scope: ["cli"] }, { id: "3", scope: ["hub"] }];
  const ids = (list) => list.map((intent) => intent.id);

  // A CLI release that just started: the CLI intent would hold the train for
  // most of it, so it waits for the next train; Web and Hub ship now.
  assert.ok(releaseMinutes("cli") > HOLD_MINUTES);
  const cli = deferWaitingIntents(intents, [{ scope: ["cli"], startedAt: ago(1) }], now);
  assert.deepEqual(ids(cli.deferred), ["2"]);
  assert.deepEqual(cli.scope, ["hub", "web"]);

  // A Web release finishes within HOLD_MINUTES: the Web intent rides now and
  // its gates run while it deploys.
  assert.ok(releaseMinutes("web") <= HOLD_MINUTES);
  assert.deepEqual(ids(deferWaitingIntents(intents, [{ scope: ["web"], startedAt: ago(1) }], now).deferred), []);

  // A long release near its end holds no longer than a short one would.
  assert.deepEqual(ids(deferWaitingIntents(intents, [{ scope: ["cli"], startedAt: ago(10) }], now).deferred), []);

  // Everything waits for a Hub release, which is short; a long release with
  // the Hub keeps every intent that waits for it open.
  assert.deepEqual(ids(deferWaitingIntents(intents, [{ scope: ["hub"], startedAt: ago(0) }], now).deferred), []);
  assert.deepEqual(ids(deferWaitingIntents(intents, [{ scope: ["hub", "cli"], startedAt: ago(0) }], now).deferred),
    ["1", "2", "3"]);

  // An unreadable release is long and waited for by everything.
  assert.deepEqual(ids(deferWaitingIntents(intents, [{ scope: [], startedAt: undefined }], now).deferred), ["1", "2", "3"]);
  assert.deepEqual(deferWaitingIntents(intents, [], now).scope, ["hub", "web", "cli"]);
});
