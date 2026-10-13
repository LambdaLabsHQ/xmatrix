import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentInstanceRuntimeTransport, AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES } from "../src/runtime-transport/agent-instance-port.ts";
import { agentInstanceAttachment, FakeSocket } from "./support/runtime-transport.mjs";

test("Hub retry delivery selects the exact owner, Run, Instance and Channel with negotiated capability", () => {
  const transport = new AgentInstanceRuntimeTransport({ capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES) });
  const socket = new FakeSocket();
  transport.rehydrate(socket, agentInstanceAttachment({ session: { clientCapabilities: ["agent_turn_retry"] } }));
  const input = { ownerUserId: "user-1", runId: "run-1", instanceId: "instance-1", channelId: "channel-1",
    message: { type: "agent_turn_retry_decision", requestId: "request", operationId: "operation", threadId: "thread",
      turnId: "turn", attemptToken: "permit", action: "retry", input: "Continue" } };
  for (const key of ["ownerUserId", "runId", "instanceId", "channelId"])
    assert.equal(transport.deliverTurnRetry({ ...input, [key]: "foreign" }), false);
  assert.deepEqual(socket.sent, []);
  assert.equal(transport.deliverTurnRetry(input), true);
  assert.deepEqual(socket.sent, [input.message]);
  const old = new AgentInstanceRuntimeTransport({ capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES) });
  const oldSocket = new FakeSocket();
  old.rehydrate(oldSocket, agentInstanceAttachment());
  assert.equal(old.deliverTurnRetry(input), false);
  assert.deepEqual(oldSocket.sent, []);
});
