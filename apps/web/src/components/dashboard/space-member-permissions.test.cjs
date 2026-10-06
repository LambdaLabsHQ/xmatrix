const { readDashboardSource } = require("./source-scan-fixture.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const {
  creationPolicyFromSwitch,
  effectiveSpaceMemberPermissions,
  spaceMemberCanCreate,
  spacePrincipalCanCreate,
} = require("./space-member-permissions.ts");

function space(role, permissions) {
  return {
    id: "space-1",
    members: [{ userId: "user-1", role }],
    memberPermissions: permissions,
  };
}

test("missing policy preserves the member-compatible Web default", () => {
  assert.deepEqual(effectiveSpaceMemberPermissions(space("member")), {
    agentCreation: "members",
    automationCreation: "members",
  });
  assert.equal(spaceMemberCanCreate(space("member"), "user-1", "agentCreation"), true);
});

test("admins policy permits owners and admins but explains the member boundary", () => {
  const permissions = { agentCreation: "admins", automationCreation: "admins" };
  assert.equal(spaceMemberCanCreate(space("owner", permissions), "user-1", "agentCreation"), true);
  assert.equal(spaceMemberCanCreate(space("admin", permissions), "user-1", "automationCreation"), true);
  assert.equal(spaceMemberCanCreate(space("member", permissions), "user-1", "agentCreation"), false);
  assert.equal(spaceMemberCanCreate(space("member", permissions), "user-1", "automationCreation"), false);
  assert.equal(
    spacePrincipalCanCreate(space("owner", permissions), { kind: "agent" }, "agentCreation"),
    false,
  );
});

test("switch state maps to the exact persisted policy", () => {
  assert.equal(creationPolicyFromSwitch(true), "members");
  assert.equal(creationPolicyFromSwitch(false), "admins");
});

test("every Web creation surface consumes the shared policy projection", () => {
  const sources = [
    "schedules-view.tsx",
    "workspace-composer-dialogs.tsx",
    "use-workspace-shell-actions.ts",
  ].map((file) => readDashboardSource(file));
  for (const source of sources) assert.match(source, /spaceMemberCanCreate\(/);
  // Only an author's own rewrite stays outside the policy; replacing another's creates.
});
