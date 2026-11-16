const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { userSpaceLocalState } = require("./user-space-local-state.ts");

const strings = userSpaceLocalState("notes", value => typeof value === "string" ? value : undefined);
const alice = { userId: "alice", spaceId: "shared" };

test.afterEach(() => { delete globalThis.window; });

test("personal device state requires a reader and a Space, with separate feature namespaces", () => {
  const values = new Map();
  const store = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  globalThis.window = { localStorage: store };
  strings.write(alice, "private");
  const other = userSpaceLocalState("other", value => value);
  for (const scope of [{ ...alice, userId: "bob" }, { ...alice, spaceId: "elsewhere" },
    { ...alice, userId: null }, { ...alice, spaceId: undefined }]) {
    assert.equal(strings.read(scope), undefined);
  }
  assert.equal(other.read(alice), undefined);
  strings.write({ ...alice, userId: null }, "anonymous");
  assert.equal(values.size, 1, "no ownerless write");
  assert.equal(strings.read(alice), "private", "the original owner can still read it");
});

test("blocked storage and malformed or invalid persisted values leave the product usable", () => {
  for (const raw of ["{bad", "42"]) {
    globalThis.window = { localStorage: { getItem: () => raw } };
    assert.equal(strings.read(alice), undefined);
  }
  globalThis.window = { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); } } };
  assert.equal(strings.read(alice), undefined);
  assert.doesNotThrow(() => strings.write(alice, "sent"));
  globalThis.window = { get localStorage() { throw new Error("denied getter"); } };
  assert.equal(strings.read(alice), undefined);
  assert.doesNotThrow(() => strings.write(alice, "sent"));
});
