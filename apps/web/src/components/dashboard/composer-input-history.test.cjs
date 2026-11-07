const assert = require("node:assert/strict");
const test = require("node:test");

require("./typescript-require.cjs").installTypeScriptRequire();
const { readInputHistory, rememberInput, inputHistoryKey, historyEntryOf, INPUT_HISTORY_LIMIT } =
  require("./composer-input-history.ts");
const { selectComposerReference, selectComposerInvocation } = require("./composer-invocation-bindings.ts");

const scope = (spaceId) => ({ userId: "alice", spaceId });
test.afterEach(() => { delete globalThis.window; });

function memoryStore() {
  const map = new Map();
  const store = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map };
  globalThis.window = { localStorage: store };
  return store;
}

test("sent drafts are remembered per reader and Space, newest first, without repeats", () => {
  memoryStore();
  rememberInput(scope("space-a"), undefined, "first");
  rememberInput(scope("space-a"), undefined, "second");
  rememberInput(scope("space-a"), undefined, "first");
  rememberInput(scope("space-b"), undefined, "elsewhere");
  assert.deepEqual(readInputHistory(scope("space-a")).map((entry) => entry.body), ["first", "second"]);
  assert.deepEqual(readInputHistory(scope("space-b")).map((entry) => entry.body), ["elsewhere"]);
  assert.deepEqual(readInputHistory(scope(null)), []);
});

test("history keeps the latest entries up to its limit and ignores empty sends", () => {
  memoryStore();
  for (let i = 0; i < INPUT_HISTORY_LIMIT + 5; i += 1) rememberInput(scope("s"), undefined, `m${i}`);
  rememberInput(scope("s"), undefined, "   ");
  const entries = readInputHistory(scope("s"));
  assert.equal(entries.length, INPUT_HISTORY_LIMIT);
  assert.equal(entries[0].body, `m${INPUT_HISTORY_LIMIT + 4}`);
});

test("a damaged store reads as no history", () => {
  const store = memoryStore();
  rememberInput(scope("s"), undefined, "initial");
  const [address] = store.map.keys();
  store.setItem(address, "{not json");
  assert.deepEqual(readInputHistory(scope("s")), []);
  store.setItem(address, JSON.stringify([{ body: "ok", references: [] }, { body: 3 },
    { body: "x", references: [{ start: 0, end: 4, text: "nope", reference: "page:1" }] }]));
  assert.deepEqual(readInputHistory(scope("s")), [{ body: "ok", references: [] }]);
});

test("picked pages stay picked, Agents go back to their written name, and pictures are left out", () => {
  const body = "see Roadmap @claude\n![shot.png](attachment:att-1)\nthanks";
  let draft = selectComposerReference(undefined, body, { start: 4, end: 11, text: "Roadmap", reference: "page:abc" });
  draft = selectComposerInvocation(draft, body, { start: 12, end: 19, text: "@claude",
    target: { kind: "instance", instanceId: "i-1" } });
  const entry = historyEntryOf(draft, body);
  assert.equal(entry.body, "see Roadmap @claude\nthanks");
  assert.deepEqual(entry.references, [{ start: 4, end: 11, text: "Roadmap", reference: "page:abc" }]);
  assert.equal(historyEntryOf(undefined, "![shot.png](attachment:att-1)"), null);
});

const entries = [{ body: "newest", references: [] }, { body: "middle", references: [] }, { body: "oldest", references: [] }];
const key = (active, keyName, draft = "", collapsed = true) =>
  inputHistoryKey({ entries, active, draft, collapsed, key: keyName });

test("↑ in an empty composer opens the list on the newest entry and climbs to the oldest", () => {
  assert.deepEqual(key(null, "ArrowUp"), { active: 0 });
  assert.deepEqual(key(0, "ArrowUp"), { active: 1 });
  assert.deepEqual(key(2, "ArrowUp"), { active: 2 });
});

test("↓ goes newer and past the newest closes the list; Escape closes it", () => {
  assert.deepEqual(key(2, "ArrowDown"), { active: 1 });
  assert.deepEqual(key(0, "ArrowDown"), { active: null });
  assert.deepEqual(key(1, "Escape"), { active: null });
  assert.equal(key(null, "ArrowDown"), null);
  assert.equal(key(null, "Escape"), null);
});

test("Enter or Tab puts the highlighted entry in the composer", () => {
  assert.deepEqual(key(1, "Enter"), { active: null, pick: entries[1] });
  assert.deepEqual(key(0, "Tab"), { active: null, pick: entries[0] });
});

test("a draft being written, a selection, or no history leaves the keys to the composer", () => {
  assert.equal(key(null, "ArrowUp", "typing"), null);
  assert.equal(key(0, "Enter", "typing"), null);
  assert.equal(key(null, "ArrowUp", "", false), null);
  assert.equal(key(1, "a"), null);
  assert.equal(inputHistoryKey({ entries: [], active: null, draft: "", collapsed: true, key: "ArrowUp" }), null);
});
