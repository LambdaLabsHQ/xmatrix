const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");

const batcherModule = compileTsModules(__dirname, ["realtime-frame-batcher"]);
const { createRealtimeFrameBatcher, humanFrameBatchKey } = batcherModule.exports;
test.after(batcherModule.dispose);

function harness() {
  const applied = [];
  const timers = [];
  const batcher = createRealtimeFrameBatcher({
    apply: (frames) => applied.push(frames.map((frame) => frame.name)),
    batchKey: (frame) => frame.key,
    setTimer: (callback) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  const fire = () => timers.splice(0).forEach((callback) => callback());
  return { applied, batcher, fire, timers };
}

test("a burst of reports is applied once, newest per key", () => {
  const { applied, batcher, fire, timers } = harness();
  batcher.push({ name: "a1", key: "a" });
  batcher.push({ name: "b1", key: "b" });
  batcher.push({ name: "a2", key: "a" });
  assert.equal(timers.length, 1);
  assert.deepEqual(applied, []);
  fire();
  assert.deepEqual(applied, [["b1", "a2"]]);
});

test("an unbatched frame never overtakes the reports waiting before it", () => {
  const { applied, batcher, fire } = harness();
  batcher.push({ name: "presence", key: "a" });
  batcher.push({ name: "message", key: null });
  assert.deepEqual(applied, [["presence", "message"]]);
  fire();
  assert.deepEqual(applied, [["presence", "message"]]);
});

test("a torn-down socket's waiting reports are dropped", () => {
  const { applied, batcher, fire } = harness();
  batcher.push({ name: "presence", key: "a" });
  batcher.dispose();
  fire();
  assert.deepEqual(applied, []);
});

test("presence coalesces per Agent and Instance set; events and messages do not", () => {
  const agent = (instances) => ({ id: "agent:a", instances: instances.map((id) => ({ id })) });
  const presence = humanFrameBatchKey({ type: "enhanced_presence", agent: agent(["i2", "i1"]) });
  assert.equal(presence, humanFrameBatchKey({ type: "presence", online: true, agent: agent(["i1", "i2"]) }));
  assert.notEqual(presence, humanFrameBatchKey({ type: "enhanced_presence", agent: agent(["i3"]) }));
  const event = { type: "observable_event", event: { id: "e" } };
  assert.notEqual(humanFrameBatchKey(event), humanFrameBatchKey(event));
  assert.equal(humanFrameBatchKey({ type: "channel_message_received" }), null);
});
