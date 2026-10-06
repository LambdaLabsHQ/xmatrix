import assert from "node:assert/strict";

import { test } from "node:test";

import {
  agentInstancePresenceCommand,
} from "../src/runtime-transport/agent-instance-presence-command.ts";
import {
  queryAgentInstanceRun,
} from "../src/runtime-transport/agent-instance-run-query.ts";

test("an Agent Instance reads its Run as the owner its credential names", async () => {
  const reads = [];
  const response = await queryAgentInstanceRun({
    async getRun(input) {
      reads.push(input);
      return { run: { id: input.runId } };
    },
  }, { runId: "run:summon:mock", ownerUserId: "owner-1" });

  assert.deepEqual(response, { run: { id: "run:summon:mock" } });
  assert.deepEqual(reads, [{ runId: "run:summon:mock", ownerUserId: "owner-1" }]);
});

for (const atomicInstanceConnect of [true, false]) test(
  `Agent Instance ${atomicInstanceConnect ? "atomic connect" : "fallback presence"} carries the signed authority route`,
  () => {
    const command = agentInstancePresenceCommand({
      atomicInstanceConnect,
      commandId: "connect-1",
      principal: { ownerUserId: "owner-1", spaceId: "space-1", channelId: "channel-1" },
      instanceId: "instance-1",
      expectedVersion: 3,
      at: "2026-09-06T00:00:00.000Z",
    });
    assert.equal(command.kind,
      atomicInstanceConnect ? "instance_connect" : "instance_transition");
    assert.equal(command.spaceId, "space-1");
    assert.equal(command.channelId, "channel-1");
    assert.equal(command.actorUserId, "owner-1");
    assert.equal(command.instanceId, "instance-1");
    assert.equal(command.expectedVersion, 3);
    assert.equal(command.status, atomicInstanceConnect ? undefined : "online");
  },
);

test("websocket close persists non-terminal offline on the signed authority route", () => {
  const command = agentInstancePresenceCommand({
    atomicInstanceConnect: false,
    commandId: "agent-transport-offline:instance-1:4",
    principal: { ownerUserId: "owner-1", spaceId: "space-1", channelId: "channel-1" },
    instanceId: "instance-1",
    expectedVersion: 4,
    at: "2026-09-11T11:00:00.000Z",
    status: "offline",
  });
  assert.equal(command.kind, "instance_transition");
  assert.equal(command.status, "offline");
  assert.equal(command.spaceId, "space-1");
  assert.equal(command.channelId, "channel-1");
  assert.equal(command.expectedVersion, 4);
  assert.equal(command.terminal, undefined);
});
