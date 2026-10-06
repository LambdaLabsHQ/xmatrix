const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { mergeSpaceListSnapshot, mergeSpaceSnapshot } = require("./workspace-space-snapshot.ts");

function space(id, managementAgent) {
  return {
    id,
    name: id,
    ownerId: "user:owner",
    members: [],
    managementAgent,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}

function config(enabled, updatedAt) {
  return {
    enabled,
    sideEffectsEnabled: true,
    identityName: "xMatrix",
    defaultChannelVisibility: "management-visible",
    ...(updatedAt ? { updatedAt } : {}),
  };
}

test("a delayed Spaces response cannot undo a newer management-agent enable", () => {
  const enabled = space("space:1", config(true, "2026-08-25T00:01:00.000Z"));
  const requestStartedBeforeEnable = space("space:1", config(false));

  assert.equal(
    mergeSpaceSnapshot(enabled, requestStartedBeforeEnable).managementAgent.enabled,
    true
  );
});

test("a newer explicit disable replaces the enabled management config", () => {
  const enabled = space("space:1", config(true, "2026-08-25T00:01:00.000Z"));
  const disabled = space("space:1", config(false, "2026-08-25T00:02:00.000Z"));

  assert.equal(mergeSpaceSnapshot(enabled, disabled).managementAgent.enabled, false);
});

test("list reconciliation does not retain Spaces absent from the authoritative response", () => {
  const current = [
    space("space:1", config(true, "2026-08-25T00:01:00.000Z")),
    space("space:removed", config(false)),
  ];
  const incoming = [space("space:1", config(false))];

  const merged = mergeSpaceListSnapshot(current, incoming);
  assert.deepEqual(merged.map((item) => item.id), ["space:1"]);
  assert.equal(merged[0].managementAgent.enabled, true);
});
