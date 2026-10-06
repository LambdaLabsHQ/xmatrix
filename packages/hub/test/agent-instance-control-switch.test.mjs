import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentInstanceRuntimeTransport,
  AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES,
} from "../src/runtime-transport/agent-instance-port.ts";
import { agentInstanceAttachment, FakeSocket } from "./support/runtime-transport.mjs";

const MODELS = [
  { id: "fable", model: "fable", isDefault: true, supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "high" },
  ] },
  { id: "opus", model: "opus", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] },
];

function attachment({ channelInstanceId, presentation } = {}) {
  return agentInstanceAttachment({
    principal: { agentName: "claude" },
    run: { instanceStatus: "idle", ...(channelInstanceId ? { channelInstanceId } : {}) },
    session: { presentation: presentation ?? { model: "opus", models: MODELS } },
  });
}

/** A live transport plus the socket its one Instance is on. */
function liveTransport({ awaitControlResult, ...options } = {}) {
  const socket = new FakeSocket();
  const transport = new AgentInstanceRuntimeTransport({
    capabilities: new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES),
    ...(awaitControlResult ? { awaitControlResult } : {}),
  });
  assert.equal(transport.rehydrate(socket, attachment(options)), true);
  return { transport, socket };
}

test("a stable Profile address switches the selected Instance without relying on its label", async () => {
  const { transport } = liveTransport({ channelInstanceId: "2" });
  const outcome = await transport.switchInstanceControl({ channelId: "channel-1", target: "agent-1:2", kind: "model" });
  assert.equal(outcome.status, "catalog");
  assert.deepEqual(await transport.switchInstanceControl({ channelId: "channel-1", target: "agent-2:2", kind: "model" }),
    { status: "no_instance" });
});

test("a switch reaches the addressed instance and reports what it confirmed", async () => {
  let seen;
  const { transport, socket } = liveTransport({
    awaitControlResult: (binding) => {
      seen = binding;
      return Promise.resolve({ value: "fable" });
    },
  });

  const outcome = await transport.switchInstanceControl({
    channelId: "channel-1",
    target: "claude:1",
    kind: "model",
    value: "fable",
  });

  assert.deepEqual(outcome, { status: "switched", selected: "fable" });
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].type, "agent_model_switch_requested");
  assert.equal(socket.sent[0].model, "fable");
  assert.equal(seen.kind, "model");
  assert.equal(seen.instanceId, "instance-1");
  // The waiter must be keyed by the same request the socket was told to answer.
  assert.equal(seen.requestId, socket.sent[0].requestId);
});

test("the channel-instance ordinal selects which instance is addressed", async () => {
  const { transport } = liveTransport({
    channelInstanceId: "3",
    awaitControlResult: () => Promise.resolve({ value: "fable" }),
  });

  assert.deepEqual(
    await switchToFable(transport),
    { status: "no_instance" },
  );
  assert.equal(
    (await transport.switchInstanceControl({
      channelId: "channel-1", target: "claude:3", kind: "model", value: "fable",
    })).status,
    "switched",
  );
});

test("another channel's instance is never addressable", async () => {
  const { transport } = liveTransport({
    awaitControlResult: () => Promise.resolve({ value: "fable" }),
  });
  assert.deepEqual(
    await transport.switchInstanceControl({
      channelId: "channel-2", target: "claude:1", kind: "model", value: "fable",
    }),
    { status: "no_instance" },
  );
});

test("a bare command reports the catalog without touching the socket", async () => {
  const { transport, socket } = liveTransport({
    awaitControlResult: () => Promise.reject(new Error("must not be asked")),
  });

  assert.deepEqual(
    await transport.switchInstanceControl({
      channelId: "channel-1", target: "claude:1", kind: "model",
    }),
    { status: "catalog", options: ["fable", "opus"], current: "opus" },
  );
  // Efforts belong to the selected model, so only opus's are offered.
  assert.deepEqual(
    await transport.switchInstanceControl({
      channelId: "channel-1", target: "claude:1", kind: "effort",
    }),
    { status: "catalog", options: ["medium"] },
  );
  assert.deepEqual(socket.sent, []);
});

test("a value outside the catalog is refused before the socket is asked", async () => {
  const { transport, socket } = liveTransport({
    awaitControlResult: () => Promise.reject(new Error("must not be asked")),
  });
  const outcome = await transport.switchInstanceControl({
    channelId: "channel-1", target: "claude:1", kind: "model", value: "gpt-5",
  });
  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /not one this instance offers/u);
  assert.deepEqual(socket.sent, []);
});

test("an instance that confirms a different value is a failure, not a switch", async () => {
  const { transport } = liveTransport({
    awaitControlResult: () => Promise.resolve({ value: "opus" }),
  });
  const outcome = await switchToFable(transport);
  assert.equal(outcome.status, "error");
  assert.match(outcome.message, /confirmed `opus` instead of `fable`/u);
});

test("a timeout or instance error is reported rather than assumed applied", async () => {
  const timedOut = liveTransport({
    awaitControlResult: () => Promise.reject(new Error("waiter timeout")),
  });
  assert.deepEqual(
    await timedOut.transport.switchInstanceControl({
      channelId: "channel-1", target: "claude:1", kind: "model", value: "fable",
    }),
    { status: "error", message: "waiter timeout" },
  );

  const refused = liveTransport({
    awaitControlResult: () => Promise.resolve({ error: "model unavailable" }),
  });
  assert.deepEqual(
    await refused.transport.switchInstanceControl({
      channelId: "channel-1", target: "claude:1", kind: "model", value: "fable",
    }),
    { status: "error", message: "model unavailable" },
  );
});

test("a composition with no waiter registry refuses instead of half-switching", async () => {
  const { transport, socket } = liveTransport();
  const outcome = await switchToFable(transport);
  assert.equal(outcome.status, "error");
  assert.deepEqual(socket.sent, []);
});

function switchToFable(transport) {
  return transport.switchInstanceControl({ channelId: "channel-1", target: "claude:1", kind: "model", value: "fable" });
}
