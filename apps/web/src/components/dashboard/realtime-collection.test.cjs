const assert = require("node:assert/strict");
const test = require("node:test");
const { installTypeScriptRequire } = require("./typescript-require.cjs");
installTypeScriptRequire();
const { createRealtimeCollection, realtimeCollectionAny } = require("./realtime-collection.ts");

test("live changes notify the affected Channel and keep the reference catalog stable", () => {
  const initial = [{ id: "open", activity: "idle" }, { id: "other", activity: "idle" }];
  const store = createRealtimeCollection(initial);
  const calls = [];
  store.subscribeCatalog(() => calls.push("catalog"));
  store.subscribeKey("open", () => calls.push("open"));
  store.subscribeKey("other", () => {
    calls.push(store.get("other").activity);
    assert.equal(store.getSnapshot()[1], store.get("other"), "publish before notifying");
  });
  store.set(current => [current[0], { ...current[1], activity: "working" }], "live");
  assert.deepEqual(calls, ["working"]);
  assert.equal(store.getCatalogSnapshot(), initial);
  store.set(current => current);
  assert.deepEqual(calls, ["working"], "a catalog no-op cannot promote live presentation");
  assert.equal(store.getCatalogSnapshot(), initial);
  assert.equal(store.get("open"), initial[0]);
  // A durable change is reduced against the current live state, never the old catalog.
  store.set(current => [...current, { id: "new" }]);
  assert.equal(store.getCatalogSnapshot()[1].activity, "working");
  assert.deepEqual(calls, ["working", "catalog"]);
});

test("a work indicator catches changes between render and subscription", () => {
  const store = createRealtimeCollection([{ id: "one", busy: false }]);
  const indicator = realtimeCollectionAny(store, item => item.busy);
  assert.equal(indicator.getSnapshot(), false);
  store.set([{ id: "one", busy: true }], "live");
  const unsubscribe = indicator.subscribe(() => {});
  assert.equal(indicator.getSnapshot(), true);
  unsubscribe();
});

test("a cleared session removes live data and notifies mounted keys once", () => {
  const store = createRealtimeCollection([{ id: "one" }, { id: "two" }]);
  let one = 0;
  let two = 0;
  store.subscribeKey("one", () => { one += 1; assert.equal(store.get("one"), undefined); });
  const unsubscribe = store.subscribeKey("two", () => { two += 1; });
  unsubscribe();
  store.set([]);
  assert.deepEqual(store.getSnapshot(), []);
  assert.deepEqual(store.getCatalogSnapshot(), []);
  assert.equal(one, 1);
  assert.equal(two, 0);
});

test("the idle work indicator reevaluates only changed Channels and observes the last worker stopping", () => {
  const store = createRealtimeCollection(Array.from({ length: 1000 }, (_, index) => ({ id: String(index), busy: false })));
  let inspected = 0;
  const indicator = realtimeCollectionAny(store, item => { inspected += 1; return item.busy; });
  const values = [];
  const unsubscribe = indicator.subscribe(() => values.push(indicator.getSnapshot()));
  inspected = 0;
  store.set(items => items.map(item => item.id === "50" ? { ...item, busy: true } : item), "live");
  assert.equal(inspected, 1);
  store.set(items => items.filter(item => item.id !== "50"));
  assert.deepEqual(values, [true, false]);
  unsubscribe();
});
