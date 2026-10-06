import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInstanceAttachment, FakeSocket, productionAgentInstanceTransport } from "./support/runtime-transport.mjs";

/** Accepts only the presentation each presence frame persists; any other change fails the test. */
function presentationRuntime() {
  const persisted = [];
  return { persisted, runtime: {
    async getRun() { throw Error("unexpected Run read"); },
    async transition(command) {
      if (command.kind !== "instance_presentation") throw Error("unexpected Instance transition");
      persisted.push(command.instanceId);
      return { instanceId: command.instanceId, recorded: true };
    },
    async holdUsageLimit() { throw Error("unexpected usage-limit hold"); },
  } };
}

function fixture(separate = {}) {
  const authority = presentationRuntime();
  const { transport } = productionAgentInstanceTransport(authority.runtime);
  const sockets = ["a", "b"].map(id => {
    const socket = new FakeSocket();
    const channelId = separate.channel ? `channel-${id}` : "channel";
    assert.equal(transport.rehydrate(socket, agentInstanceAttachment({
      principal: { ownerUserId: separate.owner ? `owner-${id}` : "owner", agentId: `agent-${id}`,
        agentName: `Agent ${id}`, spaceId: "space", runId: `run-${id}`, executionKey: `execution-${id}`, channelId,
        machineId: "machine", hostId: "host" },
      run: { instanceId: `instance-${id}`, instanceStatus: "online" },
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
