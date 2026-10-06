import assert from "node:assert/strict";
import test from "node:test";
import { groupAgentRegistrationCatalog } from "../dist/agent-registration-catalog.js";

const location = (machineId, patch = {}) => ({ key: { spaceId: "space", ownerUserId: "owner", machineId, harness: "codex" },
  displayName: "codex", ownerName: "Owner", machineName: machineId, version: 1, state: "enabled", models: ["model-a"],
  routingReady: true, canManageOwnerGrant: false, canConfigureSpace: false, canRemoveFromSpace: false, ...patch });

test("repeated labels yield one abstract capability and distinct structured locations", () => {
  const result = groupAgentRegistrationCatalog("space", [location("b"), location("a"),
    location("c", { key: { spaceId: "space", ownerUserId: "other", machineId: "c", harness: "claude_code" } })]);
  assert.deepEqual(result.map(item => item.harness), ["claude", "codex"]);
  assert.equal(result[1].locations.length, 2);
  assert.deepEqual(result[1].locations.map(item => item.key.machineId), ["a", "b"]);
  assert.deepEqual(result[1].models, ["model-a"]);
});

test("unready, disabled and revoked locations do not advertise runnable models", () => {
  const result = groupAgentRegistrationCatalog("space", [location("a", { routingReady: false }),
    location("b", { state: "disabled" }), location("c", { state: "revoked" })]);
  assert.deepEqual(result[0].models, []);
  assert.equal(result[0].locations.length, 3);
});

test("duplicate tuple and cross-Space catalogs are rejected instead of silently deduplicated", () => {
  assert.throws(() => groupAgentRegistrationCatalog("space", [location("a"), location("a")]), /Duplicate/);
  assert.throws(() => groupAgentRegistrationCatalog("other", [location("a")]), /Space/);
});
