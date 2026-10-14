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

test("an indexed live commit publishes additions, removals and replacements before notifying only their keys", () => {
  const same = { id: "same" };
  const previous = { id: "changed", activity: "before" };
  const removed = { id: "removed" };
  const initial = [same, previous, removed];
  const store = createRealtimeCollection(initial);
  const replacement = { ...previous, activity: "after" };
  const added = { id: "added" };
  const next = [same, replacement, added];
  const index = new Map(next.map(item => [item.id, item]));
  const calls = new Map();
  const changes = [];
  let live = 0;
  let catalog = 0;
  for (const id of ["same", "changed", "removed", "added", "absent"]) {
    store.subscribeKey(id, () => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      assert.equal(store.getSnapshot(), next);
      assert.equal(store.get("changed"), replacement);
      assert.equal(store.get("added"), added);
      assert.equal(store.get("removed"), undefined);
      assert.equal(store.getCatalogSnapshot(), initial);
      assert.equal(store.getCatalog("changed"), previous);
    });
  }
  store.subscribeChanges(keys => changes.push(keys));
  store.subscribe(() => { live += 1; });
  store.subscribeCatalog(() => { catalog += 1; });
  store.commit({ items: next, byId: index,
    changedKeys: ["same", "changed", "removed", "added", "changed", "absent"] }, "live");
  assert.deepEqual([...calls].sort(), [["added", 1], ["changed", 1], ["removed", 1]]);
  assert.deepEqual(changes, [["changed", "removed", "added"]]);
  assert.equal(live, 1);
  assert.equal(catalog, 0);

  store.commit({ items: next, byId: index, changedKeys: ["changed"] });
  assert.equal(live, 1);
  assert.equal(catalog, 0, "an unchanged live array cannot promote pending presentation to the catalog");
  assert.equal(store.getCatalog("changed"), previous);
});

test("indexed commits preserve ordering changes without notifying keys whose final values are unchanged", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const store = createRealtimeCollection([a, b]);
  const next = [b, a];
  const calls = [];
  store.subscribeKey("a", () => calls.push("a"));
  store.subscribeKey("b", () => calls.push("b"));
  store.subscribeChanges(() => calls.push("changes"));
  store.subscribe(() => {
    assert.equal(store.getSnapshot(), next);
    assert.equal(store.getCatalogSnapshot(), next);
    assert.equal(store.getCatalog("a"), a);
    calls.push("live");
  });
  store.subscribeCatalog(() => calls.push("catalog"));
  store.commit({ items: next, byId: new Map([["b", b], ["a", a]]), changedKeys: ["a", "b", "a"] });
  assert.deepEqual(calls, ["live", "catalog"]);
});

test("later indexed commits, ordinary catalog writes and account clearing leave previously published indices intact", () => {
  const initial = { id: "one", activity: "initial" };
  const store = createRealtimeCollection([initial]);
  const working = { ...initial, activity: "working" };
  const firstItems = [working];
  const firstIndex = new Map([[working.id, working]]);
  store.commit({ items: firstItems, byId: firstIndex, changedKeys: [working.id] }, "live");
  const durable = { id: "two", mode: "closed" };
  store.set(current => [...current, durable]);
  assert.equal(store.getCatalog("one"), working, "a catalog write includes earlier live updates");
  const catalogItems = store.getCatalogSnapshot();
  const later = { ...working, activity: "later" };
  const secondIndex = new Map([[later.id, later], [durable.id, durable]]);
  store.commit({ items: [later, durable], byId: secondIndex, changedKeys: [later.id] }, "live");
  assert.equal(store.get("one"), later);
  assert.equal(store.getCatalog("one"), working);
  assert.equal(store.getCatalogSnapshot(), catalogItems);
  let cleared = 0;
  store.subscribeKey("one", () => { cleared += 1; assert.equal(store.get("one"), undefined); });
  store.set([]);
  assert.equal(cleared, 1);
  assert.deepEqual(store.getSnapshot(), []);
  assert.deepEqual(store.getCatalogSnapshot(), []);
  assert.equal(store.getCatalog("one"), undefined);
  assert.deepEqual([...firstIndex], [[working.id, working]]);
  assert.deepEqual(firstItems, [working]);
  assert.deepEqual([...secondIndex], [[later.id, later], [durable.id, durable]]);
});
