import assert from "node:assert/strict";
import test from "node:test";

import {
  messageReceiptSelection,
} from "../src/message-receipt-selection.ts";
const human = { id: "human", email: "human@example.test" };
const agent = { ...human, id: "agent-run:one", agentRun: { runKind: "channel-instance",
  agentId: "agent", runId: "run", instanceId: "instance", executionKey: "signed-execution",
  channelId: "channel", ownerUserId: "human" } };

test("receipt selection rejects request-supplied authority and preserves verified Agent identity", () => {
  const selected = messageReceiptSelection("channel", { messageId: "message" }, agent);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.input.principal, { kind: "agent", id: "agent" });
  assert.deepEqual(selected.input.runProof, { runId: "run", instanceId: "instance", executionKey: "signed-execution" });
  for (const field of ["principal", "runProof", "actorUserId", "senderRunId", "executionKey"]) {
    assert.equal(messageReceiptSelection("channel", { messageId: "message", [field]: "forged" }, agent).status, 400);
  }
  // A send outside the birth Channel is recoverable; the authority checks the
  // Run proof, Channel read access and that the receipt's sender is this Instance.
  const foreign = messageReceiptSelection("foreign", { messageId: "message" }, agent);
  assert.equal(foreign.ok, true);
  assert.equal(foreign.input.channelId, "foreign");
  assert.deepEqual(foreign.input.runProof, selected.input.runProof);
  assert.equal(messageReceiptSelection("channel", { messageId: "message" }, {
    ...agent, agentRun: { ...agent.agentRun, instanceId: undefined } }).status, 403);
  assert.equal(messageReceiptSelection("channel", { messageId: "message" }, {
    ...agent, agentRun: { ...agent.agentRun, runKind: "channel-about-session" } }).status, 403);
});

test("receipt selections are bounded and Humans keep their own identity", () => {
  const selected = messageReceiptSelection("channel", { messageId: "message", expectedBodyHash: "a".repeat(64) }, human);
  assert.deepEqual(selected.input, { channelId: "channel", messageId: "message",
    principal: { kind: "user", id: "human" }, expectedBodyHash: "a".repeat(64) });
  for (const value of [null, [], "message", {}, { messageId: 1 }, { messageId: " " },
    { messageId: "a".repeat(161) }, { messageId: "中".repeat(54) }, { messageId: "message", expectedBodyHash: "token" }]) {
    assert.equal(messageReceiptSelection("channel", value, human).status, 400);
  }
});
