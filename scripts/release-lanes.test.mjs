import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { CLIENT_COMPONENTS, releaseLanes, SERVICE_COMPONENTS, waitsFor } from "./release-lanes.mjs";
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

test("every component is in exactly one lane", () => {
  assert.deepEqual([...SERVICE_COMPONENTS, ...CLIENT_COMPONENTS].sort(), [...COMPONENTS].sort());
});

test("the service never waits for a client release", () => {
  for (const train of ["hub", "web", "hub,web"]) {
    for (const active of ["cli", "cli,desktop", "android", "ios", "cli,desktop,android,ios"]) {
      assert.equal(waitsFor(train, active), false, `${train} behind ${active}`);
    }
    for (const active of ["hub", "web", "hub,web", "web,cli", "hub,cli"]) {
      assert.equal(waitsFor(train, active), true, `${train} behind ${active}`);
    }
  }
});

test("a client waits for clients and for an earlier Hub, not for a Web-only release", () => {
  for (const train of ["cli", "cli,desktop", "android", "ios"]) {
    assert.equal(waitsFor(train, "web"), false, train);
    for (const active of ["hub", "hub,web", "cli", "android", "ios", "web,cli"]) {
      assert.equal(waitsFor(train, active), true, `${train} behind ${active}`);
    }
  }
});

test("a release of both lanes waits for everything before it", () => {
  for (const active of scopes) assert.equal(waitsFor("hub,web,cli", active), true, active);
  for (const train of scopes) assert.equal(waitsFor(train, "web,cli"), true, train);
});

test("a scope that cannot be read holds both lanes", () => {
  for (const unknown of ["", "server", "hub,server", undefined]) {
    assert.deepEqual(releaseLanes(unknown), { service: true, client: true, hub: true });
    for (const train of scopes) assert.equal(waitsFor(train, unknown), true, `${train} behind ${unknown}`);
  }
});

test("releases that may deploy side by side never share a concurrency group", () => {
  // GitHub keeps one pending run per group and cancels the older one, so two
  // releases dispatched without waiting for each other must use different
  // groups, and Recovery must hold the group of every Hub release.
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
    assert.equal(group(scope), releaseLanes(scope).service ? "production-release-train" : "production-release-clients", scope);
    if (scope.split(",").includes("hub")) assert.equal(group(scope), recovery, scope);
    for (const later of scopes) {
      if (!waitsFor(later, scope)) assert.notEqual(group(later), group(scope), `${later} beside ${scope}`);
    }
  }
});
