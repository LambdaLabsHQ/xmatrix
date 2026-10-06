const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");

const refresh = compileTsModules(__dirname, ["channel-catalog-refresh"]);
const { coalesceCatalogChanges, createCatalogRefreshThrottle } = refresh.exports;
test.after(refresh.dispose);

test("a burst of Channel changes keeps each Channel once and the highest revision", () => {
  assert.deepEqual(coalesceCatalogChanges([
    { kind: "message", channelId: "a" },
    { kind: "revision", revision: 3 },
    { kind: "presence", channelId: "a" },
    { kind: "message", channelId: "b" },
    { kind: "revision", revision: 7 },
    { kind: "message", channelId: "b" },
  ]), [
    { kind: "revision", revision: 7 },
    { kind: "presence", channelId: "a" },
    { kind: "message", channelId: "b" },
  ]);
});

test("a structural change absorbs the per-Channel ones", () => {
  assert.deepEqual(coalesceCatalogChanges([
    { kind: "message", channelId: "a" },
    { kind: "structure", spaceId: "s" },
    { kind: "structure", spaceId: "s" },
  ]), [{ kind: "structure", spaceId: "s" }]);
});

test("the first change applies at once and the window's rest as one refresh", async () => {
  const applied = [];
  const throttle = createCatalogRefreshThrottle((spaceId, details) => applied.push({ spaceId, details }), 10);
  throttle.push("s", { kind: "structure" });
  assert.equal(applied.length, 1);
  for (let index = 0; index < 50; index += 1) throttle.push("s", { kind: "structure" });
  throttle.push("other", { kind: "message", channelId: "x" });
  assert.equal(applied.length, 2, "another Space has its own window");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(applied.filter(({ spaceId }) => spaceId === "s").map(({ details }) => details.length), [1, 1]);
  throttle.dispose();
});
