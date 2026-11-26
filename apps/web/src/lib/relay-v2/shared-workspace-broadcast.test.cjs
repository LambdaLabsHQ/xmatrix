const assert = require("node:assert/strict");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { openSharedWorkspaceBroadcast } = require("./shared-workspace-broadcast.ts");

function createFakeBroadcastClass() {
  const rooms = new Map();
  return class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      this.closed = false;
      if (!rooms.has(name)) rooms.set(name, new Set());
      rooms.get(name).add(this);
    }
    addEventListener(type, listener) {
      if (type === "message") this.listeners.add(listener);
    }
    postMessage(data) {
      if (this.closed) return;
      for (const peer of rooms.get(this.name) ?? []) {
        if (peer.closed) continue;
        for (const listener of peer.listeners) {
          listener({ data: structuredClone(data) });
        }
      }
    }
    close() {
      this.closed = true;
      rooms.get(this.name)?.delete(this);
    }
  };
}

test("openSharedWorkspaceBroadcast syncs live events and targeted snapshot request/reply without self-echo", () => {
  const FakeBC = createFakeBroadcastClass();
  const namespace = { hubOrigin: "https://hub.example", userId: "u1", clientProfileId: "p1" };
  const receivedCard = [];
  const receivedPanel = [];
  const receivedOther = [];

  const card = openSharedWorkspaceBroadcast(namespace, (event) => {
    receivedCard.push(event);
    if (event.type === "snapshot-request" && event.channelId === "ch-1") {
      card.post({
        type: "snapshot-reply",
        targetSenderId: event.senderId,
        requestId: event.requestId,
        channel: { id: "ch-1", spaceId: "sp-1", name: "Pool Notes", mode: "open" },
        messages: [{ messageId: "m1", channelId: "ch-1", sequence: 1, body: "first msg" }],
        hasOlderMessages: false,
        contentRevision: 0,
        outgoing: [{
          clientMessageId: "cm-2",
          userId: "u1",
          channelId: "ch-1",
          body: "still sending",
          sentAt: "2026-11-25T00:00:00.000Z",
          status: "pending",
        }],
      });
    }
  }, FakeBC);
  const panel = openSharedWorkspaceBroadcast(namespace, (event) => receivedPanel.push(event), FakeBC);
  const other = openSharedWorkspaceBroadcast(namespace, (event) => receivedOther.push(event), FakeBC);

  panel.post({ type: "snapshot-request", requestId: "req-1", channelId: "ch-1" });
  assert.equal(receivedCard.length, 1);
  assert.equal(receivedCard[0].type, "snapshot-request");
  assert.equal(receivedPanel.length, 1, "panel receives targeted snapshot-reply");
  assert.equal(receivedPanel[0].type, "snapshot-reply");
  assert.equal(receivedPanel[0].channel.name, "Pool Notes");
  assert.equal(receivedPanel[0].messages[0].body, "first msg");
  assert.equal(receivedPanel[0].outgoing[0].body, "still sending");
  assert.ok(!receivedOther.some((e) => e.type === "snapshot-reply"), "unrelated peer ignores targeted snapshot-reply");

  card.post({
    type: "outgoing-upsert",
    message: {
      clientMessageId: "cm-3",
      userId: "u1",
      channelId: "ch-1",
      body: "live follow-up",
      sentAt: "2026-11-25T00:00:01.000Z",
      status: "pending",
    },
  });
  assert.ok(!receivedCard.some((e) => e.type === "outgoing-upsert"), "sender ignores own echo");
  assert.equal(receivedPanel.at(-1).type, "outgoing-upsert");
  assert.equal(receivedPanel.at(-1).message.body, "live follow-up");

  card.close();
  panel.close();
  other.close();
});

test("openSharedWorkspaceBroadcast degrades to a no-op when BroadcastChannel is absent", () => {
  const handle = openSharedWorkspaceBroadcast(
    { hubOrigin: "https://hub.example", userId: "u1", clientProfileId: "p1" },
    () => { throw new Error("should not be called"); },
    undefined,
  );
  handle.post({ type: "channel-delete", channelId: "ch-1" });
  handle.close();
});
