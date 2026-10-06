import assert from "node:assert/strict";
import test from "node:test";
import { parseRegistrationOwnerGrant, parseRegistrationResourceLimits, intersectRegistrationLimits,
  registrationLimitsWithin, validateRegistrationAdmission } from "../dist/agent-registration-access.js";

const key = { spaceId: "space-a", ownerUserId: "owner", machineId: "macbook", harness: "codex" };
const limits = { workspaces: ["workspace-a"], models: ["model-a"], capabilities: [] };
const input = { key, grant: { revision: 1, executionRevision: 1, state: "active", limits },
  policy: { revision: 1, executionRevision: 1, state: "enabled", limits }, ownerIsMember: true, callerMayLaunch: true,
  requested: { ...limits, maxConcurrent: 1 } };

test("Space policy intersects every resource dimension and cannot expand owner authority", () => {
  const broad = { ...limits, models: ["model-a", "model-b"], maxConcurrent: 4 };
  assert.equal(registrationLimitsWithin(broad, limits), false);
  assert.deepEqual(intersectRegistrationLimits(limits, broad), limits);
  assert.deepEqual(validateRegistrationAdmission({ ...input, requested: broad }), { allowed: false, reason: "resources" });
  assert.deepEqual(validateRegistrationAdmission({ ...input, requested: { ...input.requested,
    capabilities: ["browser-login"] } }), { allowed: false, reason: "resources" });
});

test("revocation, a Space disable, departure and caller rights independently deny admission", () => {
  for (const [patch, reason] of [
    [{ ownerIsMember: false }, "membership"], [{ callerMayLaunch: false }, "caller"],
    [{ grant: { ...input.grant, state: "revoked" } }, "revoked"],
    [{ policy: { ...input.policy, state: "disabled" } }, "disabled"],
  ]) assert.deepEqual(validateRegistrationAdmission({ ...input, ...patch }), { allowed: false, reason });
});

test("late startup must match the exact Space tuple and current authorization revisions", () => {
  const admitted = validateRegistrationAdmission(input);
  assert.equal(admitted.allowed, true);
  assert.equal(validateRegistrationAdmission({ ...input, fence: admitted.fence }).allowed, true);
  for (const field of Object.keys(key)) {
    const fence = { ...admitted.fence, key: { ...key, [field]: "other" } };
    assert.deepEqual(validateRegistrationAdmission({ ...input, fence }), { allowed: false, reason: "stale_authorization" });
  }
  for (const field of ["grant", "policy"]) assert.deepEqual(validateRegistrationAdmission({ ...input,
    [field]: { ...input[field], revision: 3 }, fence: admitted.fence,
  }), { allowed: false, reason: "stale_authorization" });
});

test("access parsers reject wildcards, unknown authority fields and invalid limits", () => {
  for (const invalid of [{ ...limits, capabilities: ["*"] }, { ...limits, models: ["model-a", "model-a"] },
    { ...limits, workspaces: undefined }]) assert.throws(() => parseRegistrationResourceLimits(invalid));
  assert.deepEqual(parseRegistrationResourceLimits({ ...limits, admin: true }), limits);
  // Limits stored before secrets moved to the Space still parse, without them.
  assert.deepEqual(parseRegistrationResourceLimits({ ...limits, secrets: ["stored-secret"] }), limits);
  assert.throws(() => parseRegistrationOwnerGrant({ ...input.grant, revision: 0 }));
  assert.throws(() => parseRegistrationOwnerGrant({ ...input.grant, state: "enabled" }));
  assert.equal(validateRegistrationAdmission({ ...input, grant: {
    ...input.grant, limits: { ...limits, maxConcurrent: 0 },
  } }).allowed, true);
  assert.deepEqual(parseRegistrationResourceLimits({ ...limits, maxConcurrent: 0 }), limits);
});

test("a Space disable stops admitted work too; there is no pause", () => {
  const fence = validateRegistrationAdmission(input).fence;
  const disabled = { ...input, fence, phase: "continuation", policy: { ...input.policy, revision: 2, executionRevision: 2, state: "disabled" } };
  assert.deepEqual(validateRegistrationAdmission(disabled), { allowed: false, reason: "disabled" });
  const enabled = { ...disabled, policy: { ...disabled.policy, revision: 3, state: "enabled" } };
  assert.deepEqual(validateRegistrationAdmission(enabled), { allowed: false, reason: "stale_authorization" },
    "enabling again does not revive stopped work");
  assert.throws(() => validateRegistrationAdmission({ ...input, policy: { ...input.policy, state: "paused" } }));
});

test("narrow then expand cannot resurrect an admitted execution; another Space is fenced", () => {
  const fence = validateRegistrationAdmission(input).fence;
  const continuation = { ...input, fence, phase: "continuation" };
  for (const policy of [
    { ...input.policy, revision: 2, executionRevision: 2, limits: { ...limits, models: [] } },
    { ...input.policy, revision: 3, executionRevision: 2 },
  ]) assert.deepEqual(validateRegistrationAdmission({ ...continuation, policy }),
    { allowed: false, reason: "stale_authorization" });
  assert.deepEqual(validateRegistrationAdmission({ ...continuation, key: { ...key, spaceId: "other" } }),
    { allowed: false, reason: "stale_authorization" });
  assert.deepEqual(validateRegistrationAdmission({ ...continuation, grant: { ...input.grant, revision: 3, executionRevision: 2 } }),
    { allowed: false, reason: "stale_authorization" });
});

test("grant expansion and retired fields preserve admitted work, not stale startups", () => {
  const fence = validateRegistrationAdmission(input).fence;
  const expanded = { ...input, fence, grant: { ...input.grant, revision: 2,
    limits: { ...limits, models: ["model-a", "model-b"] } } };
  assert.equal(validateRegistrationAdmission({ ...expanded, phase: "continuation" }).allowed, true);
  assert.deepEqual(validateRegistrationAdmission(expanded), { allowed: false, reason: "stale_authorization" });
  const reducedCapacity = { ...expanded, grant: { ...expanded.grant, revision: 3,
    limits: { ...expanded.grant.limits, maxConcurrent: 1 } } };
  assert.equal(validateRegistrationAdmission({ ...reducedCapacity, phase: "continuation" }).allowed, true);
  for (const grant of [{ ...input.grant, revision: 2, executionRevision: 2, state: "revoked" },
    { ...input.grant, revision: 3, executionRevision: 3 }]) {
    assert.equal(validateRegistrationAdmission({ ...input, fence, phase: "continuation", grant }).allowed, false);
  }
});

test("model admission is literal: an empty grant admits only the runtime default, never a harness-named model", () => {
  const none = { ...limits, models: [] };
  const empty = { ...input, grant: { ...input.grant, limits: none }, policy: { ...input.policy, limits: none } };
  // The runtime default requests no model resource.
  assert.equal(validateRegistrationAdmission({ ...empty, requested: none }).allowed, true);
  for (const model of [key.harness, "model-a"]) {
    assert.deepEqual(validateRegistrationAdmission({ ...empty, requested: { ...none, models: [model] } }),
      { allowed: false, reason: "resources" });
  }
  // An explicit list admits exactly its members; the harness name is just another string.
  assert.equal(validateRegistrationAdmission(input).allowed, true);
  assert.deepEqual(validateRegistrationAdmission({ ...input, requested: { ...limits, models: [key.harness] } }),
    { allowed: false, reason: "resources" });
});
