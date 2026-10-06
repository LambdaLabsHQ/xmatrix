import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { legacyMachineDaemonId, sha256HexSync, stableMachineDaemonId } from "../dist/machine-daemon-id.js";

const DERIVED = `machine:${"a".repeat(64)}`;
const LEGACY = "machine:11111111-1111-4111-8111-111111111111";

test("the synchronous digest is SHA-256 over UTF-8", () => {
  for (const value of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "o\0machine:ü漢字"]) {
    assert.equal(sha256HexSync(value), createHash("sha256").update(value).digest("hex"));
  }
});

test("a host-derived Machine keeps one daemon id whatever its host name", () => {
  const id = stableMachineDaemonId("user-1", DERIVED, "studio");
  assert.equal(id, `daemon:${createHash("sha256").update(`user-1\0${DERIVED}`).digest("hex")}`);
  assert.equal(stableMachineDaemonId("user-1", DERIVED, "renamed-studio"), id);
  assert.notEqual(stableMachineDaemonId("user-2", DERIVED, "studio"), id);
});

test("a legacy minted Machine keeps its per-host FNV daemon id until it adopts", () => {
  assert.equal(stableMachineDaemonId("user-1", LEGACY, "studio"), "daemon:f37e1c93");
  assert.notEqual(stableMachineDaemonId("user-1", LEGACY, "laptop"), "daemon:f37e1c93");
});

test("the pre-SHA id of a host-derived Machine is its per-host FNV id", () => {
  assert.equal(legacyMachineDaemonId("user-1", LEGACY, "studio"), "daemon:f37e1c93");
  assert.match(legacyMachineDaemonId("user-1", DERIVED, "studio"), /^daemon:[0-9a-f]{8}$/u);
  assert.notEqual(legacyMachineDaemonId("user-1", DERIVED, "studio"), stableMachineDaemonId("user-1", DERIVED, "studio"));
});
