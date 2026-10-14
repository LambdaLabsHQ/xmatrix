const assert = require("node:assert/strict");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { createHumanFramePackets, isDeferredHumanFrame } = require("./human-frame-packets.ts");

function packets(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const received = [];
  const buffer = createHumanFramePackets({ deliver: (frames) => received.push(frames) });
  t.after(() => buffer.dispose());
  return { buffer, received, push: (value) => buffer.push(JSON.stringify(value)) };
}

test("Human state waits at most one short window without dropping repeated cards", (t) => {
  const { received, push } = packets(t);
  for (const step of [1, 2, 3]) push({ type: "enhanced_presence", agent: { id: "same" }, step });
  t.mock.timers.tick(15);
  assert.equal(received.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(received[0].map((frame) => frame.value.step), [1, 2, 3]);
});

test("messages, digests and malformed frames are immediate ordered barriers", (t) => {
  const { buffer, received, push } = packets(t);
  push({ type: "presence", sequence: 1 });
  push({ type: "message", sequence: 2 });
  assert.deepEqual(received[0].map((frame) => frame.value.sequence), [1, 2]);
  push({ type: "channel_updated", sequence: 3 });
  push({ type: "presence_digest", sequence: 4 });
  assert.deepEqual(received[1].map((frame) => frame.value.sequence), [3, 4]);
  buffer.push("not JSON");
  assert.deepEqual(received[2], [{ kind: "raw", data: "not JSON" }]);
  push({ type: "agent_lifecycle", sequence: 5 });
  t.mock.timers.tick(16);
  assert.equal(received[3][0].value.sequence, 5, "bad input never poisons later state");
  assert.equal(isDeferredHumanFrame({ type: "observable_event" }), true);
  assert.equal(isDeferredHumanFrame({ type: "future_authority_change" }), false);
});

test("a busy socket has bounded packets and disposal drops an old session's tail", (t) => {
  const { buffer, received, push } = packets(t);
  for (let sequence = 0; sequence < 600; sequence += 1) push({ type: "presence", sequence });
  assert.ok(received.length >= 2, "a producer cannot grow an unlimited pending array");
  buffer.flush();
  assert.deepEqual(received.flat().map((frame) => frame.value.sequence), Array.from({ length: 600 }, (_, i) => i));
  push({ type: "presence", sequence: 600 });
  buffer.dispose();
  t.mock.timers.tick(1_000);
  assert.equal(received.flat().length, 600);
});

test("one large snapshot flushes rather than retaining more large snapshots", (t) => {
  const { received, push } = packets(t);
  push({ type: "channel_updated", body: "x".repeat(1_048_576) });
  assert.equal(received.length, 1);
  assert.equal(received[0].length, 1);
});
