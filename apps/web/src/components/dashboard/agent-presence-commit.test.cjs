const assert = require("node:assert/strict");
const { test } = require("node:test");
const { installTypeScriptRequire } = require("./typescript-require.cjs");
installTypeScriptRequire();
const { createAgentPresenceCommit } = require("./agent-presence-commit.ts");
const { createRealtimeCollection } = require("./realtime-collection.ts");

test("an empty Agent report preserves the snapshot and has nothing to publish", () => {
  const agents = [{ id: "agent-one", name: "One" }];
  const commit = createAgentPresenceCommit(agents, []);
  assert.equal(commit.items, agents);
  assert.equal(commit.byId.get("agent-one"), agents[0]);
  assert.deepEqual(commit.changedKeys, []);
  const store = createRealtimeCollection(agents);
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  store.subscribeCatalog(() => { calls += 1; });
  store.commit(commit);
  assert.equal(calls, 0);
});

test("a report replaces the whole Agent card while unchanged names keep their existing order", () => {
  const previous = Object.freeze({ id: "agent-z", name: "Zeta", model: "old-model", instances: [{ id: "old-run" }] });
  const unchanged = Object.freeze({ id: "agent-a", name: "Alpha" });
  const agents = Object.freeze([previous, unchanged]);
  const replacement = { id: previous.id, name: previous.name, activity: "Current step" };
  const commit = createAgentPresenceCommit(agents, [replacement]);
  assert.deepEqual(commit.items, [replacement, unchanged]);
  assert.equal(commit.byId.get(previous.id), replacement);
  assert.equal("model" in commit.items[0], false, "a complete card cannot inherit omitted fields");
  assert.equal("instances" in commit.items[0], false);
  assert.deepEqual(commit.changedKeys, [previous.id]);
  assert.deepEqual(agents, [previous, unchanged]);
});

test("adding an Agent or changing its name restores name order", () => {
  const alpha = { id: "agent-a", name: "Alpha" };
  const zeta = { id: "agent-z", name: "Zeta" };
  const middle = { id: "agent-m", name: "Middle" };
  const added = createAgentPresenceCommit([alpha, zeta], [middle]);
  assert.deepEqual(added.items, [alpha, middle, zeta]);
  assert.deepEqual(added.changedKeys, [middle.id]);
  const renamed = { ...zeta, name: "Beta" };
  const changed = createAgentPresenceCommit(added.items, [renamed]);
  assert.deepEqual(changed.items, [alpha, renamed, middle]);
  assert.equal(changed.byId.get(zeta.id), renamed);
});

test("the last complete card wins for a repeated id and only its final name affects ordering", () => {
  const zeta = { id: "agent-z", name: "Zeta" };
  const alpha = { id: "agent-a", name: "Alpha" };
  const temporary = { id: zeta.id, name: "Before Alpha", activity: "Temporary", model: "temporary" };
  const final = { id: zeta.id, name: zeta.name, activity: "Final" };
  const commit = createAgentPresenceCommit([zeta, alpha], [temporary, final]);
  assert.deepEqual(commit.items, [final, alpha], "a reverted name does not reorder an existing snapshot");
  assert.equal(commit.byId.get(zeta.id), final);
  assert.equal("model" in commit.byId.get(zeta.id), false);
  assert.deepEqual(commit.changedKeys, [zeta.id]);
  const added = createAgentPresenceCommit([alpha], [temporary, final]);
  assert.deepEqual(added.items, [alpha, final]);
  assert.equal(added.byId.size, 2);
});

test("later reductions leave the previous array and index available to existing readers", () => {
  const first = createAgentPresenceCommit([], [{ id: "agent-one", name: "One", activity: "First" }]);
  Object.freeze(first.items);
  const replacement = { id: "agent-one", name: "Renamed", activity: "Later" };
  const next = createAgentPresenceCommit(first.items, [replacement]);
  assert.equal(first.items[0].activity, "First");
  assert.equal(first.byId.get(replacement.id), first.items[0]);
  assert.equal(next.items[0], replacement);
  assert.equal(next.byId.get(replacement.id), replacement);
  assert.notEqual(next.byId, first.byId);
});

test("the indexed collection publishes the latest Agent once and preserves its catalog until a durable change", () => {
  const stable = { id: "agent-a", name: "Alpha" };
  const initial = { id: "agent-b", name: "Beta", activity: "Initial" };
  const store = createRealtimeCollection([stable, initial]);
  const first = { ...initial, activity: "First" };
  const latest = { ...initial, activity: "Latest" };
  const commit = createAgentPresenceCommit(store.getSnapshot(), [stable, first, latest]);
  const notified = [];
  const changes = [];
  store.subscribeKey(stable.id, () => notified.push("unchanged"));
  store.subscribeKey(initial.id, () => {
    notified.push("changed");
    assert.equal(store.getSnapshot(), commit.items);
    assert.equal(store.get(initial.id), latest);
    assert.equal(store.getCatalog(initial.id), initial);
  });
  store.subscribeChanges(keys => changes.push(keys));
  store.commit(commit, "live");
  assert.deepEqual(notified, ["changed"]);
  const newcomer = { id: "agent-c", name: "Charlie" };
  store.commit(createAgentPresenceCommit(store.getSnapshot(), [newcomer]));
  assert.equal(store.getCatalog(initial.id), latest);
  assert.equal(store.getCatalog(newcomer.id), newcomer);
  assert.equal(commit.byId.has(newcomer.id), false);
  assert.deepEqual(changes, [[initial.id], [newcomer.id]]);
});
