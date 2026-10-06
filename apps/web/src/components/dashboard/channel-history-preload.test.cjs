const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");
const compiled = compileTsModules(__dirname, ["channel-history-preload"]);
const { ChannelHistoryPreload } = compiled.exports;
test.after(compiled.dispose);

test("route metadata and history share an in-flight read, consumed once", async () => {
  const preload = new ChannelHistoryPreload();
  let finish;
  let reads = 0;
  const read = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  preload.start("user/token/channel/epoch", read, 100);
  preload.start("user/token/channel/epoch", read, 101);
  const pending = preload.take("user/token/channel/epoch", 7, 102);
  finish({ historyHeadSequence: 7, messages: ["first"] });
  assert.deepEqual(await pending, { historyHeadSequence: 7, messages: ["first"] });
  assert.equal(reads, 1);
  assert.equal(await preload.take("user/token/channel/epoch", 7, 103), undefined);
});

test("identity changes and cancellation never deliver a previous user's page", async () => {
  const preload = new ChannelHistoryPreload();
  let signal, finish;
  preload.start("user-a/token/channel/epoch", abort => {
    signal = abort;
    return new Promise(resolve => { finish = resolve; });
  }, 100);
  assert.equal(await preload.take("user-b/token/channel/epoch", 0, 101), undefined);
  const pending = preload.take("user-a/token/channel/epoch", 0, 101);
  preload.clear();
  finish({ historyHeadSequence: 5 });
  assert.equal(signal.aborted, true);
  assert.equal(await pending, undefined);
});

test("expired, failed, and behind-head speculative reads fall back to normal history", async () => {
  const preload = new ChannelHistoryPreload();
  preload.start("key", async () => ({ historyHeadSequence: 4 }), 100);
  assert.equal(await preload.take("key", 5, 101), undefined);
  preload.start("key", async () => { throw new Error("revoked"); }, 100);
  assert.equal(await preload.take("key", 0, 101), undefined);
  preload.start("key", async () => ({ historyHeadSequence: 9 }), 100);
  assert.equal(await preload.take("key", 0, 15_101), undefined);
});
