const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { channelReferences } = require("./message-reference-catalog.tsx");

const channel = (id, extra = {}) => ({
  id, spaceId: "space", name: id, topic: "", summary: "", messageCount: 1, updatedAt: "2026-10-14T00:00:00.000Z", ...extra,
});

test("a channel's messages leave the references as they were", () => {
  const first = channelReferences([], [channel("general"), channel("release")]);
  const active = channelReferences(first, [
    channel("general", { messageCount: 2, updatedAt: "2026-10-14T00:01:00.000Z", lastMessage: { body: "new" } }),
    channel("release"),
  ]);
  assert.equal(active, first);
});

test("a reference that reads differently, or stands elsewhere, makes a new list", () => {
  const first = channelReferences([], [channel("general"), channel("release")]);
  const renamed = channelReferences(first, [channel("general", { name: "town-square" }), channel("release")]);
  assert.notEqual(renamed, first);
  assert.equal(renamed[0].name, "town-square");
  assert.equal(renamed[1], first[1], "the reference that reads the same is kept");
  const reordered = channelReferences(first, [channel("release"), channel("general")]);
  assert.deepEqual(reordered.map((reference) => reference.id), ["release", "general"]);
  assert.notEqual(reordered, first);
  assert.notEqual(channelReferences(first, [channel("general", { topic: "Ships" }), channel("release")]), first);
});
