import assert from "node:assert/strict";
import test from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const compatibility = await loadTypescriptModule(
  new URL("../src/client-compatibility.ts", import.meta.url),
);

test("client versions use strict SemVer precedence", () => {
  assert.equal(compatibility.compareClientVersions("0.15.53", "0.15.52"), 1);
  assert.equal(compatibility.compareClientVersions("0.15.53-rc.1", "0.15.53"), -1);
  assert.equal(compatibility.compareClientVersions("0.15.53+build.7", "0.15.53"), 0);
  assert.equal(compatibility.compareClientVersions("0.15", "0.15.52"), undefined);
  assert.equal(compatibility.compareClientVersions("0.15.053", "0.15.52"), undefined);
});

test("the exact-authority cutover admits only current app, CLI, and daemon clients", () => {
  // The CLI and its daemon start at the published hostname-only producer release.
  const minimum = { app: ["0.16.160", "0.16.159"], cli: ["0.16.698", "0.16.697"], daemon: ["0.16.698", "0.16.697"] };
  for (const [component, [floor, below]] of Object.entries(minimum)) {
    assert.equal(compatibility.evaluateClientCompatibility({
      component, version: floor, protocolVersion: 2,
    }).compatible, true);
    const rejected = compatibility.evaluateClientCompatibility({
      component, version: below, protocolVersion: 2,
    });
    assert.equal(rejected.compatible, false);
    assert.equal(rejected.minimumVersion, floor);
    assert.equal(rejected.updateCommand, component === "app" ? undefined : "xmatrix update");
    assert.equal(rejected.retryable, false);
  }
});

test("missing, malformed, and unsupported identities fail closed", () => {
  assert.equal(compatibility.missingClientCompatibilityDecision().reason, "identity_missing");
  assert.equal(compatibility.evaluateClientCompatibility({
    component: "app", version: "not-a-version", protocolVersion: 2,
  }).reason, "identity_invalid");
  assert.equal(compatibility.evaluateClientCompatibility({
    component: "app", version: "99.0.0", protocolVersion: 1,
  }).reason, "protocol_unsupported");
});

test("browser WebSocket URLs carry the same non-secret compatibility identity", () => {
  const result = new URL(compatibility.withClientCompatibilityQuery(
    "wss://hub.example/ws/humans",
    { component: "app", version: "0.16.160", protocolVersion: 2, platform: "ios" },
  ));
  assert.equal(result.pathname, "/ws/humans");
  assert.equal(result.searchParams.get("x-xmatrix-client-component"), "app");
  assert.equal(result.searchParams.get("x-xmatrix-client-version"), "0.16.160");
  assert.equal(result.searchParams.get("x-xmatrix-client-protocol"), "2");
  assert.equal(result.searchParams.get("x-xmatrix-client-platform"), "ios");
});
