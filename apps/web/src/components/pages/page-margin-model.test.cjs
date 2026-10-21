const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  MARGIN_GAP, anchorTop, layoutMargin, listedMessage, marginConversations, sectionConversationCounts, withOpenConversation,
} = require("./page-margin-model.ts");

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW - hours * 3_600_000).toISOString();
const NOW_ISO = new Date(NOW).toISOString();

function link(overrides) {
  return { linkId: `l-${overrides.conversationId}`, pageId: "p", blockId: "", source: "manual",
    createdAt: hoursAgo(100), lastSeenAt: hoursAgo(100), anchor: null, resolvedAt: null, ...overrides };
}

function conversation(overrides) {
  return { conversationId: "c", name: "A conversation", activityAt: hoursAgo(100), headSequence: 3, readSequence: 3,
    lastMessage: null, agents: [], ...overrides };
}

const anchor = { quote: "Shipped today", from: {}, to: {} };

test("a conversation sits by its most specific link: a discussion's passage, then a section, then the page", () => {
  const cards = marginConversations({
    now: NOW,
    links: [
      link({ conversationId: "a", blockId: "status" }),
      link({ conversationId: "a", linkId: "discussion", blockId: "status", anchor }),
      link({ conversationId: "b", blockId: "" }),
      link({ conversationId: "c", blockId: "notes" }),
    ],
    conversations: [conversation({ conversationId: "a" }), conversation({ conversationId: "b" }),
      conversation({ conversationId: "c" })],
  });
  const by = new Map(cards.map((card) => [card.conversationId, card]));
  assert.equal(by.get("a").anchor, "text:discussion");
  assert.equal(by.get("a").quote, "Shipped today");
  assert.equal(by.get("a").linkId, "discussion");
  assert.equal(by.get("b").anchor, "page");
  assert.equal(by.get("c").anchor, "block:notes");
  assert.equal(by.get("c").quote, null);
});

test("open discussions, live Agents, unread messages and the last day keep a conversation beside the page", () => {
  const cards = marginConversations({
    now: NOW,
    links: ["discussion", "agent", "unread", "recent", "quiet", "never-read", "resolved"].map((conversationId) =>
      link({ conversationId, blockId: "status", ...(conversationId === "discussion" ? { anchor } : {}),
        ...(conversationId === "resolved" ? { anchor, resolvedAt: hoursAgo(50) } : {}) })),
    conversations: [
      conversation({ conversationId: "discussion" }),
      conversation({ conversationId: "agent", agents: [{ instanceId: "i", name: "claude:2", status: "busy" }] }),
      conversation({ conversationId: "unread", headSequence: 9, readSequence: 4 }),
      conversation({ conversationId: "recent", activityAt: hoursAgo(2) }),
      conversation({ conversationId: "quiet" }),
      conversation({ conversationId: "never-read", headSequence: 40, readSequence: 0 }),
      conversation({ conversationId: "resolved" }),
    ],
  });
  const live = Object.fromEntries(cards.map((card) => [card.conversationId, card.live]));
  assert.deepEqual(live, { discussion: true, agent: true, unread: true, recent: true, quiet: false,
    "never-read": false, resolved: false });
  assert.equal(cards.find((card) => card.conversationId === "unread").unread, 5);
  assert.equal(cards.find((card) => card.conversationId === "never-read").unread, 0,
    "a conversation the reader never opened has nothing unread for them");
  const resolved = cards.find((card) => card.conversationId === "resolved");
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.anchor, "block:status", "a resolved discussion falls back to its section");
  assert.deepEqual(Object.fromEntries(sectionConversationCounts(cards)), { status: { total: 7, quiet: 3 } });
});

test("a conversation the listing leaves out is not shown, and what the client knows live wins when newer", () => {
  const links = [link({ conversationId: "mine", blockId: "status" }), link({ conversationId: "hidden" })];
  const cards = marginConversations({
    now: NOW, links,
    conversations: [conversation({ conversationId: "mine", name: "Old name",
      lastMessage: { from: { kind: "user", label: "Ann" }, bodyPreview: "Earlier", sentAt: hoursAgo(30) } })],
    live: (conversationId) => conversationId === "mine" ? {
      name: "Release notes",
      lastMessage: { face: { kind: "agent", name: "claude:1", harness: "claude", id: "i" }, label: "claude:1",
        bodyPreview: "Done", sentAt: hoursAgo(1) },
      agents: [{ instanceId: "i", name: "claude:1", status: "idle",
        face: { kind: "agent", name: "claude:1", harness: "claude", id: "i" } }], headSequence: 8, readSequence: 6,
    } : null,
  });
  assert.deepEqual(cards.map((card) => card.conversationId), ["mine"]);
  const [card] = cards;
  assert.equal(card.name, "Release notes");
  assert.equal(card.lastMessage.bodyPreview, "Done");
  assert.equal(card.unread, 2);
  assert.equal(card.activityAt, hoursAgo(1));
  assert.equal(card.live, true);

  const older = marginConversations({ now: NOW, links });
  assert.deepEqual(older.map((item) => item.conversationId).sort(), ["hidden", "mine"],
    "an older Hub lists no conversations, and every link still shows");
});

test("an anchor whose text is gone falls back to its section, then to the top", () => {
  const tops = new Map([["block:status", 120], ["page", 0]]);
  assert.equal(anchorTop(tops, { anchor: "text:gone", blockId: "status" }), 120);
  assert.equal(anchorTop(tops, { anchor: "text:gone", blockId: "missing" }), 0);
  assert.equal(anchorTop(new Map([["text:l", 300]]), { anchor: "text:l", blockId: "status" }), 300);
});

test("cards sit at their anchors and push down the ones after them; a focused card sits exactly at its anchor", () => {
  const cards = [{ id: "a", top: 100, height: 80 }, { id: "b", top: 120, height: 60 }, { id: "c", top: 400, height: 40 }];
  assert.deepEqual(Object.fromEntries(layoutMargin(cards)),
    { a: 100, b: 180 + MARGIN_GAP, c: 400 });
  assert.deepEqual(Object.fromEntries(layoutMargin(cards, "b")),
    { a: 120 - MARGIN_GAP - 80, b: 120, c: 400 });
  // Near the top, the focused card's neighbours cannot move above the page: the column moves down instead.
  const crowded = layoutMargin([{ id: "a", top: 0, height: 50 }, { id: "b", top: 10, height: 50 }], "b");
  assert.equal(crowded.get("a"), 0);
  assert.equal(crowded.get("b"), 50 + MARGIN_GAP);
});

test("the margin fits the page: near its end the cards move up, and what still does not fit beside an open one waits", () => {
  const cards = [{ id: "a", top: 100, height: 80 }, { id: "open", top: 900, height: 500 }, { id: "b", top: 950, height: 60 }];
  // Without the end, the open card sits at its anchor and pushes the one after it far below.
  assert.deepEqual(Object.fromEntries(layoutMargin(cards, "open")), { a: 100, open: 900, b: 1400 + MARGIN_GAP });
  // With room, nothing changes.
  assert.deepEqual(Object.fromEntries(layoutMargin(cards, "open", 2000)), Object.fromEntries(layoutMargin(cards, "open")));
  // Near the end, the open card rises only to end with the page, and the card after it is left out while it is open.
  assert.deepEqual(Object.fromEntries(layoutMargin(cards, "open", 1000)), { a: 100, open: 500 });
  // With nothing open, the cards past the end move up, in their order, until the last ends with the page.
  const closed = [{ id: "a", top: 100, height: 80 }, { id: "b", top: 950, height: 60 }, { id: "c", top: 960, height: 60 }];
  assert.deepEqual(Object.fromEntries(layoutMargin(closed, null, 1000)),
    { a: 100, b: 1000 - 60 - MARGIN_GAP - 60, c: 1000 - 60 });
  // A page shorter than its cards keeps the first ones and leaves out the rest.
  const short = layoutMargin(closed, null, 150);
  assert.deepEqual(Object.fromEntries(short), { a: 0, b: 80 + MARGIN_GAP });
});

test("the conversation open in the margin shows there even once it has sunk, or before the page links it", () => {
  const cards = marginConversations({
    now: NOW,
    links: [link({ conversationId: "quiet", blockId: "notes" })],
    conversations: [conversation({ conversationId: "quiet" })],
  });
  assert.equal(cards[0].live, false);
  const open = withOpenConversation(cards, "quiet");
  assert.equal(open.length, 1);
  assert.equal(open[0].live, true);
  assert.equal(open[0].anchor, "block:notes");
  assert.equal(cards[0].live, false, "the listing itself is unchanged");

  const unlinked = withOpenConversation(cards, "elsewhere", "Elsewhere");
  assert.equal(unlinked.length, 2);
  assert.deepEqual({ ...unlinked[1], activityAt: undefined }, { conversationId: "elsewhere", name: "Elsewhere",
    anchor: "page", blockId: "", quote: null, linkId: null, lastMessage: null, agents: [], unread: 0,
    activityAt: undefined, live: true, resolved: false });
  assert.deepEqual(withOpenConversation(cards, null), cards);
});

test("the listing's people and Agents are drawn by their own faces, never by their names", () => {
  const [card] = marginConversations({
    now: NOW,
    links: [link({ conversationId: "c", blockId: "status" })],
    conversations: [conversation({
      lastMessage: { from: { kind: "user", label: "Ann", userId: "u-ann" }, bodyPreview: "Ship it", sentAt: hoursAgo(1) },
      agents: [{ instanceId: "c:2", name: "claude:2", status: "busy", harness: "claude" },
        { instanceId: "c:3", name: "renamed:3", status: "online" }],
    })],
  });
  assert.deepEqual(card.lastMessage, { face: { kind: "user", id: "u-ann", name: "Ann" }, label: "Ann",
    bodyPreview: "Ship it", sentAt: hoursAgo(1) });
  assert.deepEqual(card.agents, [
    { instanceId: "c:2", name: "claude:2", status: "busy", face: { kind: "agent", name: "claude:2", harness: "claude", id: "c:2" } },
    { instanceId: "c:3", name: "renamed:3", status: "online", face: { kind: "agent", name: "renamed:3", harness: null, id: "c:3" } },
  ], "an Agent is drawn by its harness, or else read by its Instance");
  const listed = (from) => listedMessage({ from, bodyPreview: "", sentAt: NOW_ISO }).face;
  assert.deepEqual(listed({ kind: "agent", label: "claude:1", userId: "o", instanceId: "c:1",
    registration: { ownerUserId: "o", machineId: "m", harness: "claude_code" } }),
  { kind: "agent", name: "claude:1", harness: "claude_code", id: "c:1" });
  assert.deepEqual(listed({ kind: "user", label: "Ann", userId: "u-ann", avatarUrl: "https://example.com/old.png" }),
    { kind: "user", id: "u-ann", name: "Ann" }, "a person is their account's face, not the picture the message carried");
  assert.deepEqual(listed({ kind: "user", label: "Ann", userId: "", avatarUrl: "https://example.com/old.png" }),
    { kind: "external", name: "Ann" }, "a sender the listing does not name is no one's face, not an old picture");
});
