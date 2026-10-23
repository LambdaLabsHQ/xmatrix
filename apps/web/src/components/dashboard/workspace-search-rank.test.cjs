const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { buildWorkspaceSearchResults, searchMatchingChannels } = require("./workspace-shell-helpers-extra.tsx");
const { rankSearchResults, searchMatchTier } = require("./workspace-search-rank.ts");

function channel(id, name, sentAt, extra = {}) {
  return { id, spaceId: "space", name, mode: "open", createdAt: "2026-01-01T00:00:00.000Z",
    lastMessage: { messageId: `m-${id}`, sentAt, bodyPreview: "" }, ...extra };
}

// The conversations a search for "Connector" found on 2026-10-18, when the two
// newest were cut from the first rows because results were ordered by id.
const channels = [
  channel("0aaa", "app/connector", "2026-05-01T00:00:00.000Z"),
  channel("1bbb", "各家connector接入微信小程序", "2026-06-01T00:00:00.000Z"),
  channel("1ccc", "iOS审核拒因查询", "2026-10-01T00:00:00.000Z", { summary: "查询各类 connector 信息" }),
  channel("2dbd", "Connector 消息唤醒 agent instance", "2026-10-18T17:36:00.000Z"),
  channel("da24", "Connector 新消息唤醒休眠 agent", "2026-10-18T17:45:00.000Z"),
  channel("f000", "connector", "2026-01-02T00:00:00.000Z"),
];

test("a match tier reads the title: whole, start, anywhere, then elsewhere", () => {
  assert.equal(searchMatchTier("Connector", "#connector"), 0);
  assert.equal(searchMatchTier("connector", "Connector 消息唤醒"), 1);
  assert.equal(searchMatchTier("connector", "app/connector"), 2);
  assert.equal(searchMatchTier("connector", "iOS审核拒因查询"), 3);
});

test("ranking is by tier, then the most recent; ties keep their given order", () => {
  const ranked = rankSearchResults([
    { id: "old-start", rank: { tier: 1, activityMs: 1 } },
    { id: "elsewhere", rank: { tier: 3, activityMs: 9 } },
    { id: "new-start", rank: { tier: 1, activityMs: 5 } },
    { id: "tie-a", rank: { tier: 2, activityMs: 0 } },
    { id: "tie-b", rank: { tier: 2, activityMs: 0 } },
  ], (item) => item.rank);
  assert.deepEqual(ranked.map((item) => item.id), ["new-start", "old-start", "tie-a", "tie-b", "elsewhere"]);
});

test("conversations rank by how the title matches, then by recent activity, not by id", () => {
  assert.deepEqual(searchMatchingChannels(channels, "Connector").map((item) => item.id),
    ["f000", "da24", "2dbd", "1bbb", "0aaa", "1ccc"]);
});

test("everything found shares one ranking, whatever its kind", () => {
  const results = buildWorkspaceSearchResults({
    query: "connector", channels, agents: [], projects: [], machineDaemons: [], events: [], messages: [],
    spaces: [{ id: "space", name: "Lambda Labs", members: [
      { userId: "u1", name: "Connector Bot", role: "member" },
    ] }],
    pages: [{ pageId: "p1", title: "Connector 平台", updatedAt: "2026-10-18T17:46:00.000Z" }],
  });
  assert.deepEqual(results.slice(0, 5).map((result) => result.id),
    ["channel:f000", "page:p1", "channel:da24", "channel:2dbd", "member:space:u1"]);
});

test("Jev's reading reorders below whole-title matches and never adds or drops a result", () => {
  const { applySearchRerank } = require("./workspace-search-rank.ts");
  const rows = [
    { key: "exact", tier: 0 }, { key: "a", tier: 1 }, { key: "b", tier: 1 }, { key: "c", tier: 2 },
    { key: "unread", tier: 3 }, { key: "d", tier: 3 },
  ];
  const order = (reading) => applySearchRerank(rows, (row) => row.key, (row) => row.tier, reading).map((row) => row.key);
  assert.deepEqual(order(null), ["exact", "a", "b", "c", "unread", "d"]);
  assert.deepEqual(order({ best: "d", results: [
    { key: "exact", probability: 0 }, { key: "a", probability: 0.05 }, { key: "b", probability: 0.4 },
    { key: "c", probability: 0.9 }, { key: "d", probability: 0.8 },
  ] }), ["exact", "d", "c", "b", "unread", "a"]);
  assert.deepEqual(order({ best: "exact", results: [] }), ["exact", "a", "b", "c", "unread", "d"]);
});
