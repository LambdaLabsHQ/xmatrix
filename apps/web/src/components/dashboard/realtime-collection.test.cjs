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

test("live Agent cards replace complete values and repeated ids use only the final card and name", () => {
  const previous = Object.freeze({ id: "z", name: "Zeta", model: "old", instances: [{ id: "old-run" }] });
  const alpha = Object.freeze({ id: "a", name: "Alpha" });
  const initial = Object.freeze([previous, alpha]);
  const store = createRealtimeCollection(initial, item => item.name);
  const final = { id: "z", name: "Zeta", activity: "Latest step" };
  store.receive([{ id: "z", name: "Before Alpha", activity: "Temporary", model: "temporary" }, final]);
  assert.equal(store.get("z"), final);
  assert.deepEqual(store.getSnapshot(), [final, alpha], "a reverted name preserves existing order, even when it was unsorted");
  assert.equal("instances" in store.get("z"), false);
  assert.equal("model" in store.get("z"), false, "a complete card cannot inherit omitted fields");
  assert.equal(store.getCatalogSnapshot(), initial);
  assert.equal(store.getCatalog("z"), previous);
  assert.deepEqual(initial, [previous, alpha]);
});

test("added and renamed Agents sort immediately, including stable name ties across unread batches", () => {
  const alpha = { id: "a", name: "Alpha" };
  const beta = { id: "b", name: "Beta" };
  const store = createRealtimeCollection([alpha, beta], item => item.name);
  store.receive([{ id: "b", name: "Alpha" }]);
  store.receive([{ id: "a", name: "Zeta" }]);
  store.receive([{ id: "a", name: "Alpha" }]);
  assert.deepEqual(store.getSnapshot().map(item => item.id), ["b", "a"], "deferred readers retain the ordering of every preceding batch");
  const middle = { id: "m", name: "Middle" };
  const omega = { id: "o", name: "Omega" };
  store.receive([{ id: "o", name: "Temporary" }, omega, middle]);
  assert.deepEqual(store.getSnapshot().map(item => item.id), ["b", "a", "m", "o"]);
  store.receive([{ id: "m", name: "Zulu" }]);
  assert.deepEqual(store.getSnapshot().map(item => item.id), ["b", "a", "o", "m"]);
});

test("receiving publishes a complete batch before isolated key notifications and preserves identical-card notifications", () => {
  const stable = { id: "a", name: "Alpha" };
  const before = { id: "b", name: "Beta", activity: "Before" };
  const initial = [stable, before];
  const store = createRealtimeCollection(initial, item => item.name);
  const latest = { ...before, activity: "Latest" };
  const added = { id: "c", name: "Charlie" };
  const calls = [];
  store.subscribeKey("a", () => calls.push("a"));
  for (const id of ["b", "c"]) store.subscribeKey(id, () => {
    calls.push(id);
    assert.equal(store.get("b"), latest);
    assert.equal(store.get("c"), added);
    assert.deepEqual(store.getSnapshot(), [stable, latest, added]);
    assert.equal(store.getCatalogSnapshot(), initial);
  });
  store.subscribeChanges(keys => calls.push([...keys]));
  store.subscribe(() => calls.push("live"));
  store.subscribeCatalog(() => calls.push("catalog"));
  store.receive([stable, { ...before, activity: "First" }, added, latest]);
  assert.deepEqual(calls, ["b", "c", ["b", "c"], "live"]);
  const published = store.getSnapshot();
  assert.equal(store.getSnapshot(), published);
  calls.length = 0;
  store.receive([stable, latest, added]);
  assert.deepEqual(calls, ["live"]);
  const repeated = store.getSnapshot();
  assert.notEqual(repeated, published, "a nonempty report retains a new global snapshot even when all cards are identical");
  assert.equal(store.getSnapshot(), repeated);
  calls.length = 0;
  store.receive([]);
  assert.deepEqual(calls, []);
  assert.equal(store.getSnapshot(), repeated);
});

test("received updates leave previously published arrays and external live indices unchanged", () => {
  const original = { id: "one", name: "One", activity: "Original" };
  const initial = [original];
  const store = createRealtimeCollection(initial, item => item.name);
  const first = { ...original, activity: "First" };
  const externalItems = Object.freeze([first]);
  const externalIndex = new Map([[first.id, first]]);
  store.commit({ items: externalItems, byId: externalIndex, changedKeys: [first.id] }, "live");
  const second = { ...original, activity: "Second" };
  store.receive([second]);
  const published = Object.freeze(store.getSnapshot());
  const third = { ...original, activity: "Third" };
  store.receive([third]);
  assert.equal(store.get("one"), third);
  assert.deepEqual(store.getSnapshot(), [third]);
  assert.deepEqual(externalItems, [first]);
  assert.deepEqual([...externalIndex], [[first.id, first]], "a live commit's Map is retained by its producer");
  assert.deepEqual(published, [second]);
  assert.equal(store.getCatalogSnapshot(), initial);
  assert.equal(store.getCatalog("one"), original);
});

test("ordinary writes and indexed rollback resolve pending received cards before checking array identity", () => {
  const original = { id: "one", activity: "Original" };
  const initial = [original];
  const store = createRealtimeCollection(initial);
  const latest = { id: "one", activity: "Latest" };
  let catalogCalls = 0;
  store.subscribeCatalog(() => { catalogCalls += 1; });
  store.receive([latest]);
  store.set(current => {
    assert.equal(current[0], latest);
    return current;
  });
  assert.equal(catalogCalls, 0, "an updater no-op cannot promote received presentation");
  assert.equal(store.getCatalogSnapshot(), initial);
  store.set(initial);
  assert.equal(store.get("one"), original);
  assert.equal(catalogCalls, 1, "restoring a prior array after receiving is a real change");
  store.receive([latest]);
  store.commit({ items: initial, byId: new Map([[original.id, original]]), changedKeys: [original.id] });
  assert.equal(store.get("one"), original);
  assert.equal(store.getSnapshot(), initial);
  assert.equal(catalogCalls, 2);
  store.receive([latest]);
  const durable = { id: "two" };
  store.set(current => [...current, durable]);
  assert.deepEqual(store.getCatalogSnapshot(), [latest, durable]);
});

test("a failed received ordering leaves pending state intact and cannot poison a later good batch", () => {
  const initial = [{ id: "one", name: "One", activity: "Original" }, { id: "two", name: "Two" }];
  let rejectSort = false;
  const store = createRealtimeCollection(initial, item => {
    if (rejectSort && item.id === "two") throw new Error("Ordering unavailable");
    return item.name;
  });
  const pending = { ...initial[0], activity: "Pending" };
  store.receive([pending]);
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  assert.throws(() => store.receive([{ id: "one", name: "One", activity: "Discarded" }, { id: "bad", name: undefined }]), /Invalid realtime ordering key/);
  rejectSort = true;
  assert.throws(() => store.receive([{ id: "new", name: "New" }]), /Ordering unavailable/);
  rejectSort = false;
  assert.equal(calls, 0);
  assert.equal(store.get("bad"), undefined);
  assert.equal(store.get("new"), undefined);
  assert.equal(store.get("one"), pending);
  assert.deepEqual(store.getSnapshot(), [pending, initial[1]]);
  assert.equal(store.getCatalogSnapshot(), initial);
  const good = { id: "new", name: "New" };
  store.receive([good]);
  assert.deepEqual(store.getSnapshot(), [good, pending, initial[1]]);
  assert.equal(calls, 1);
});

test("account clearing removes received cards even when no complete snapshot was read", () => {
  const original = { id: "old-account", name: "Original" };
  const store = createRealtimeCollection([original], item => item.name);
  store.receive([{ ...original, activity: "Pending" }]);
  const removed = [];
  store.subscribeKey(original.id, () => {
    removed.push(original.id);
    assert.equal(store.get(original.id), undefined);
    assert.equal(store.getCatalog(original.id), undefined);
  });
  store.set([]);
  assert.deepEqual(removed, [original.id]);
  assert.deepEqual(store.getSnapshot(), []);
  assert.deepEqual(store.getCatalogSnapshot(), []);
  const nextAccount = { id: "next-account", name: "Next" };
  store.receive([nextAccount]);
  assert.deepEqual(store.getSnapshot(), [nextAccount]);
  assert.equal(store.get(original.id), undefined);
});

test("promotion publishes a pending received snapshot only to catalog subscribers and preserves that index", () => {
  const original = { id: "agent", name: "Agent", activity: "Original" };
  const store = createRealtimeCollection([original], item => item.name);
  const latest = { ...original, activity: "Latest" };
  store.receive([latest]);
  const calls = [];
  store.subscribeKey(original.id, () => calls.push("key"));
  store.subscribeChanges(() => calls.push("changes"));
  store.subscribe(() => calls.push("live"));
  store.subscribeCatalog(() => {
    calls.push("catalog");
    assert.equal(store.getCatalogSnapshot(), store.getSnapshot());
    assert.equal(store.getCatalog(original.id), latest);
  });
  store.promote();
  const promoted = store.getCatalogSnapshot();
  assert.deepEqual(calls, ["catalog"]);
  store.promote();
  assert.deepEqual(calls, ["catalog"], "promoting the same snapshot is a no-op");
  store.receive([{ ...latest, activity: "Later" }]);
  assert.equal(store.getCatalogSnapshot(), promoted);
  assert.equal(store.getCatalog(original.id), latest);
  assert.deepEqual(promoted, [latest]);
  assert.deepEqual(calls, ["catalog", "key", "changes", "live"]);
});

test("received publication identity is captured before a synchronous subscriber replaces it", () => {
  const original = { id: "one", activity: "Original" };
  const received = { ...original, activity: "Received" };
  const replacement = { ...original, activity: "Reconciled" };
  const store = createRealtimeCollection([original]);
  const previous = store.getSnapshot();
  let captured;
  const stop = store.subscribeKey(original.id, () => {
    stop();
    store.set([replacement]);
  });
  store.receive([received], (items, basis) => {
    captured = items;
    assert.equal(basis, previous);
    assert.equal(store.getSnapshot(), items);
    assert.equal(store.get(original.id), received);
  });
  assert.deepEqual(captured, [received]);
  assert.notEqual(captured, store.getSnapshot());
  assert.equal(store.get(original.id), replacement);
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  store.receive([], (items, basis) => {
    assert.equal(items, store.getSnapshot());
    assert.equal(items, basis);
  });
  assert.equal(calls, 0, "an empty reduction captures its existing basis without publishing");
});

test("an indexed reduction with a superseded basis notifies every reverted or removed key", () => {
  const a = { id: "a", activity: "Original A" };
  const b = { id: "b", activity: "Original B" };
  const initial = [a, b];
  const store = createRealtimeCollection(initial);
  const replacement = { ...a, activity: "Staged A" };
  const next = [replacement, b];
  const staged = { basis: initial, items: next, byId: new Map(next.map(item => [item.id, item])), changedKeys: [a.id] };
  store.set([a, { ...b, activity: "Concurrent B" }, { id: "c" }]);
  const notified = [];
  for (const id of ["a", "b", "c"]) store.subscribeKey(id, () => {
    notified.push(id);
    assert.equal(store.getSnapshot(), next);
  });
  store.commit(staged);
  assert.deepEqual(notified, ["a", "b", "c"]);
  assert.equal(store.get("c"), undefined);
  assert.equal(store.get("b"), b);
});
