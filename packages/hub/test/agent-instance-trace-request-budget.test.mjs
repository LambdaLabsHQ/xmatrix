import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_HOST_TRACE_MAX_PENDING_REQUESTS_PER_INSTANCE } from "../src/agent-host-trace.ts";
import {
  AgentInstanceRuntimeTransport,
  AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES,
} from "../src/runtime-transport/agent-instance-port.ts";
import { agentInstanceAttachment, FakeSocket } from "./support/runtime-transport.mjs";

/** A transport whose one live Instance is on the returned socket. */
function liveTransport() {
  const runtime = new AgentInstanceRuntimeTransport({
    capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES),
  });
  const socket = new FakeSocket();
  assert.equal(runtime.rehydrate(socket, agentInstanceAttachment()), true);
  return { runtime, socket };
}

function liveRead(runtime, index) {
  // Each viewer follows from its own watermark, so no two reads coalesce.
  const since = new Date(Date.UTC(2026, 9, 7, 9, 0, index)).toISOString();
  return runtime.requestTraceHistory("instance-1", { maxEvents: 100, since, waitMs: 25_000 });
}

test("closed viewers' held live reads do not report a connected host as overloaded", async () => {
  const { runtime, socket } = liveTransport();

  const abandoned = Array.from({ length: AGENT_HOST_TRACE_MAX_PENDING_REQUESTS_PER_INSTANCE },
    (_, index) => liveRead(runtime, index));
  void liveRead(runtime, AGENT_HOST_TRACE_MAX_PENDING_REQUESTS_PER_INSTANCE);

  assert.deepEqual(await abandoned[0], {
    availability: "unavailable", complete: false, events: [], reason: "host_timeout",
  }, "the oldest held read is answered early");
  assert.equal(socket.sent.filter((message) => message.type === "trace_history_requested").length,
    AGENT_HOST_TRACE_MAX_PENDING_REQUESTS_PER_INSTANCE + 1, "the new viewer reached the host");
});

test("a full budget of reads that do not wait is still overloaded", async () => {
  const { runtime } = liveTransport();

  for (let index = 0; index < AGENT_HOST_TRACE_MAX_PENDING_REQUESTS_PER_INSTANCE; index += 1) {
    void runtime.requestTraceHistory("instance-1", { maxEvents: index + 1 });
  }
  assert.equal((await runtime.requestTraceHistory("instance-1", { maxEvents: 100 })).reason,
    "host_overloaded");
});
