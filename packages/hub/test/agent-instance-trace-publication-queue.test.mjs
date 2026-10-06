import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentInstanceRuntimeTransport,
  AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES,
} from "../src/runtime-transport/agent-instance-port.ts";
import { agentInstanceAttachment, FakeSocket } from "./support/runtime-transport.mjs";

function socketBackend() {
  const calls = [];
  return {
    calls,
    capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES),
    async authenticate() { throw new Error("not used by rehydrated test socket"); },
    async refresh() { throw new Error("not used"); },
    async execute(_session, message) {
      calls.push(message.type);
      if (message.type !== "channel_message") return undefined;
      return {
        type: "channel_message_dispatched",
        requestId: message.requestId,
        messageId: "message-1",
        channelId: message.channelId,
        recipients: [],
      };
    },
  };
}

test("legacy llm traces are discarded before the Agent authority queue", async () => {
  const socket = new FakeSocket();
  const port = socketBackend();
  const transport = new AgentInstanceRuntimeTransport(port);
  assert.equal(transport.rehydrate(socket, agentInstanceAttachment()), true);

  await transport.handleFrame(socket, JSON.stringify({
    type: "event_publish",
    channelId: "channel-1",
    eventType: "llm_trace",
    payload: { event: "assistant_delta" },
  }));
  assert.deepEqual(port.calls, []);

  await transport.handleFrame(socket, JSON.stringify({
    type: "channel_message",
    requestId: "message-request-1",
    channelId: "channel-1",
    body: "continue",
  }));
  assert.deepEqual(port.calls, ["channel_message"]);
  assert.equal(socket.sent.at(-1).type, "channel_message_dispatched");
});
