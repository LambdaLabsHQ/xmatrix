const assert = require("node:assert/strict");
const test = require("node:test");
let codec, decoding, syncProtocol, Y;
test.before(async () => {
  [codec, decoding, syncProtocol, Y] = await Promise.all([
    import("./page-sync-codec.ts"), import("lib0/decoding"), import("y-protocols/sync"), import("yjs"),
  ]);
});

function payload(frame, expectedTag) {
  const decoder = decoding.createDecoder(frame);
  assert.equal(decoding.readVarUint(decoder), expectedTag);
  return decoder;
}

test("page sync framing exchanges real Yjs steps and suppresses an empty response", () => {
  const server = new Y.Doc();
  const client = new Y.Doc();
  try {
    server.getText("body").insert(0, "live page");
    const stepOne = codec.encodePageSync(encoder => syncProtocol.writeSyncStep1(encoder, client));
    const response = codec.readPageSyncReply(payload(stepOne, 0), server, server);
    assert.equal(response.kind, syncProtocol.messageYjsSyncStep1);
    assert.ok(response.reply);
    const received = codec.readPageSyncReply(payload(response.reply, 0), client, client);
    assert.equal(received.kind, syncProtocol.messageYjsSyncStep2);
    assert.equal(received.reply, undefined);
    assert.equal(client.getText("body").toString(), "live page");
    server.getText("body").insert(9, " update");
    const update = codec.encodePageSync(encoder => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(server)));
    assert.equal(codec.readPageSyncReply(payload(update, 0), client, client).reply, undefined);
    assert.equal(client.getText("body").toString(), "live page update");
  } finally {
    server.destroy();
    client.destroy();
  }
});

test("page awareness preserves the independent payload bytes under tag one", () => {
  const awareness = Uint8Array.of(1, 2, 255);
  const decoder = payload(codec.encodePageAwareness(awareness), 1);
  assert.deepEqual(decoding.readVarUint8Array(decoder), awareness);
  assert.equal(decoding.hasContent(decoder), false);
});
