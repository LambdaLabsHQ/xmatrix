import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInstanceAttachment, FakeSocket, productionAgentInstanceTransport } from "./support/runtime-transport.mjs";

/**
 * Accepts only the presentation each presence frame persists, and with
 * `unregister` an Instance's own unregister; any other change fails the test.
 */
function presentationRuntime(unregister = false) {
  const persisted = [];
  return { persisted, runtime: {
    async getRun() {
      if (!unregister) throw Error("unexpected Run read");
      return { run: { metadata: {} } };
    },
    async transition(command) {
      if (unregister && command.kind === "instance_transition" && command.status === "offline") {
        return { instanceId: command.instanceId, recorded: true };
      }
      if (command.kind !== "instance_presentation") throw Error("unexpected Instance transition");
      persisted.push(command.instanceId);
      return { instanceId: command.instanceId, recorded: true };
    },
    async holdUsageLimit() { throw Error("unexpected usage-limit hold"); },
  } };
}

/** Instance `id`'s attachment: one owner and Channel unless `separate` says otherwise. */
function attachment(id, separate = {}, run = {}) {
  return agentInstanceAttachment({
    principal: { ownerUserId: separate.owner ? `owner-${id}` : "owner", agentId: `agent-${id}`,
      agentName: `Agent ${id}`, spaceId: "space", runId: `run-${id}`, executionKey: `execution-${id}`,
      channelId: separate.channel ? `channel-${id}` : "channel", machineId: "machine", hostId: "host" },
    run: { instanceId: `instance-${id}`, instanceStatus: "online", connectionVersion: 1, ...run },
  });
}

function fixture(separate = {}) {
  const authority = presentationRuntime(separate.unregister);
  const { transport } = productionAgentInstanceTransport(authority.runtime);
  const sockets = ["a", "b"].map(id => {
    const socket = new FakeSocket();
    assert.equal(transport.rehydrate(socket, attachment(id, separate)), true);
    return socket;
  });
  return { transport, sockets, persisted: authority.persisted };
}
const presence = JSON.stringify({ type: "presence_update", status: "busy" });
const errors = socket => socket.sent.filter(frame => frame.type === "error");

async function concurrently(transport, sockets) {
  let timeout;
  try {
    await Promise.race([
      Promise.all(sockets.map(socket => transport.handleFrame(socket, presence))),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("presence deadlocked")), 1_000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

test("sequential production presence fanout completes", async () => {
  const { transport, sockets, persisted } = fixture();
  for (const socket of sockets) await transport.handleFrame(socket, presence);
  assert.ok(sockets.every(socket => socket.sent.length === 1));
  assert.deepEqual(persisted.sort(), ["instance-a", "instance-b"], "each Instance persists its presentation");
});

test("simultaneous production presence fanout completes without circular queue waits", async () => {
  const { transport, sockets } = fixture();
  await concurrently(transport, sockets);
  assert.ok(sockets.every(socket => socket.sent.length === 1));
  assert.equal(sockets[0].sent[0].agent.instanceId, "instance-b");
  assert.equal(sockets[1].sent[0].agent.instanceId, "instance-a");
});

test("concurrent broadcasts retain their owner and Channel boundary", async () => {
  for (const separation of [{ owner: true }, { channel: true }]) {
    const { transport, sockets } = fixture(separation);
    await concurrently(transport, sockets);
    assert.ok(sockets.every(socket => socket.sent.length === 0));
  }
});

test("an unregistered Instance leaves the live fanout of its peers", async () => {
  const { transport, sockets: [gone, peer] } = fixture({ unregister: true });
  await transport.handleFrame(gone, JSON.stringify({ type: "unregister", requestId: "bye" }));
  assert.deepEqual(gone.sent.map(frame => frame.type), ["unregistered"]);
  await transport.handleFrame(peer, JSON.stringify({ ...JSON.parse(presence), requestId: "peer" }));
  assert.deepEqual(errors(peer), [], "the peer's presence update succeeds");
  assert.equal(gone.sent.length, 1, "nothing is delivered to the unregistered socket");
});

test("a peer whose socket refuses the frame does not fail the sender", async (t) => {
  const { transport, sockets: [closing, sender], persisted } = fixture();
  closing.send = () => { throw new TypeError("WebSocket is already closed"); };
  const warned = t.mock.method(console, "warn", () => {});
  await transport.handleFrame(sender, JSON.stringify({ ...JSON.parse(presence), requestId: "sender" }));
  assert.deepEqual(errors(sender), []);
  assert.deepEqual(persisted, ["instance-b"], "the sender's own presence is recorded");
  assert.deepEqual(warned.mock.calls.map(call => [call.arguments[0], call.arguments[1].instanceId]),
    [["Agent Instance live signal was not delivered", "instance-a"]]);
});

test("a binding its transport gave up is reported once, then dropped", async (t) => {
  const { transport, sockets: [gone, sender] } = fixture();
  // The same host restored without live delivery: the predecessor's socket closes, its binding stays.
  assert.equal(transport.rehydrate(new FakeSocket(), attachment("a", {}, { channelDeliveryEnabled: false })), true);
  const reported = t.mock.method(console, "error", () => {});
  for (const status of ["busy", "online"]) {
    await transport.handleFrame(sender, JSON.stringify({ type: "presence_update", status, requestId: status }));
  }
  assert.deepEqual(errors(sender), []);
  assert.equal(gone.sent.length, 0);
  assert.deepEqual(reported.mock.calls.map(call => call.arguments[1]?.code), ["agent_delivery_binding_stale"]);
});
