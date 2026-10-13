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

function fixture(separate = {}) {
  const authority = presentationRuntime(separate.unregister);
  const { transport } = productionAgentInstanceTransport(authority.runtime);
  const sockets = ["a", "b"].map(id => {
    const socket = new FakeSocket();
    const channelId = separate.channel ? `channel-${id}` : "channel";
    assert.equal(transport.rehydrate(socket, agentInstanceAttachment({
      principal: { ownerUserId: separate.owner ? `owner-${id}` : "owner", agentId: `agent-${id}`,
        agentName: `Agent ${id}`, spaceId: "space", runId: `run-${id}`, executionKey: `execution-${id}`, channelId,
        machineId: "machine", hostId: "host" },
      run: { instanceId: `instance-${id}`, instanceStatus: "online", connectionVersion: 1 },
    })), true);
    return socket;
  });
  return { transport, sockets, persisted: authority.persisted };
}
const presence = JSON.stringify({ type: "presence_update", status: "busy" });

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
  assert.deepEqual(peer.sent.filter(frame => frame.type === "error"), [], "the peer's presence update succeeds");
  assert.equal(gone.sent.length, 1, "nothing is delivered to the unregistered socket");
});
