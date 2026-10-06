const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  agentTraceExactInstanceIds,
  agentTraceInstanceIds,
  agentTraceScopeMatchesTarget,
  resolveAgentTraceTargetOwner,
} = require("./agent-trace-target.ts");

test("agentTraceInstanceIds includes runtime and channel instance ids", () => {
  assert.deepEqual(
    agentTraceInstanceIds({
      id: "runtime-instance-id",
      channelInstanceId: "3",
      label: "claude:3",
      connectedAt: "2026-05-26T00:00:00.000Z",
      lastSeenAt: "2026-05-26T00:00:01.000Z",
      status: "busy",
    }),
    ["runtime-instance-id", "3"]
  );
});

test("agentTraceInstanceIds de-duplicates matching ids", () => {
  assert.deepEqual(
    agentTraceInstanceIds({
      id: "1",
      channelInstanceId: "1",
      label: "codex:1",
      connectedAt: "2026-05-26T00:00:00.000Z",
      lastSeenAt: "2026-05-26T00:00:01.000Z",
      status: "busy",
    }),
    ["1"]
  );
});

test("on-demand reads use only exact global instance ids, never channel ordinals", () => {
  assert.deepEqual(agentTraceExactInstanceIds({
    instanceId: "runtime-instance-id",
    instanceIds: ["runtime-instance-id", "3"],
    exactInstanceIds: ["runtime-instance-id", "runtime-instance-id"],
  }), ["runtime-instance-id"]);
  assert.deepEqual(agentTraceExactInstanceIds({
    instanceIds: ["runtime-instance-id", "3"],
  }), []);
});

test("agentTraceScopeMatchesTarget matches channel-scoped trace replicas by channel instance id", () => {
  const instance = {
    id: "runtime-instance-id",
    channelInstanceId: "2",
    label: "claude:2",
    connectedAt: "2026-05-26T00:00:00.000Z",
    lastSeenAt: "2026-05-26T00:00:01.000Z",
    status: "busy",
  };
  const target = {
    id: "agent:claude",
    channelId: "channel-a",
    instanceScoped: true,
    instanceIds: agentTraceInstanceIds(instance),
  };

  assert.equal(
    agentTraceScopeMatchesTarget(
      { channelId: "channel-a", agentId: "agent:claude", instanceId: "2" },
      target,
      "channel-a"
    ),
    true
  );
});

test("agentTraceScopeMatchesTarget preserves the old failure when only runtime id is present", () => {
  const target = {
    id: "agent:claude",
    channelId: "channel-a",
    instanceScoped: true,
    instanceIds: ["runtime-instance-id"],
  };

  assert.equal(
    agentTraceScopeMatchesTarget(
      { channelId: "channel-a", agentId: "agent:claude", instanceId: "2" },
      target,
      "channel-a"
    ),
    false
  );
});

test("agentTraceScopeMatchesTarget does not match another agent", () => {
  const target = {
    id: "agent:claude",
    channelId: "channel-a",
    instanceScoped: true,
    instanceIds: ["runtime-instance-id", "2"],
  };

  assert.equal(
    agentTraceScopeMatchesTarget(
      { channelId: "channel-a", agentId: "agent:codex", instanceId: "2" },
      target,
      "channel-a"
    ),
    false
  );
});

test("resolveAgentTraceTargetOwner fills ownership for instance-scoped entry points", () => {
  const target = {
    id: "agent:grok",
    instanceId: "instance-a",
    instanceScoped: true,
  };

  assert.deepEqual(
    resolveAgentTraceTargetOwner(target, [
      { id: "agent:other", userId: "owner-other" },
      { id: "agent:grok", userId: "owner-grok" },
    ]),
    { ...target, ownerUserId: "owner-grok" }
  );
  assert.equal(target.ownerUserId, undefined, "the caller's target must not be mutated");
});

test("resolveAgentTraceTargetOwner preserves explicit ownership and fails closed for unknown agents", () => {
  const explicit = { id: "agent:grok", ownerUserId: "owner-explicit" };
  assert.equal(
    resolveAgentTraceTargetOwner(explicit, [{ id: "agent:grok", userId: "owner-registry" }]),
    explicit
  );

  const unknown = { id: "agent:unknown", instanceId: "instance-a" };
  assert.equal(
    resolveAgentTraceTargetOwner(unknown, [{ id: "agent:grok", userId: "owner-grok" }]),
    unknown
  );
});
