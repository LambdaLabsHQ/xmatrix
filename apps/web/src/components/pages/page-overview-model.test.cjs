const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { overviewAttentionKey, overviewKept, overviewLists, overviewSeenThrough, overviewSpan, overviewTreeKey, overviewWaits,
  resultAgent, resultKey } = require("./page-overview-model.ts");

const now = new Date(2026, 10, 28, 22, 0, 0);
const at = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
const result = (pageId, revision, kind, hoursAgo) => ({ pageId, title: pageId, revision, kind, text: `${kind} ${revision}`,
  block: null, createdAt: at(hoursAgo), authors: [], conversationIds: [] });

test("a range is a stretch of the reader's own days, and away begins where they last saw", () => {
  const midnight = new Date(2026, 10, 28).getTime();
  assert.deepEqual(overviewSpan("today", now, null), { from: midnight, to: Infinity });
  assert.deepEqual(overviewSpan("yesterday", now, null), { from: new Date(2026, 10, 27).getTime(), to: midnight });
  const week = now.getTime() - 7 * 24 * 3_600_000;
  assert.deepEqual(overviewSpan("week", now, at(3)), { from: week, to: Infinity }, "the week does not depend on what they saw");
  assert.deepEqual(overviewSpan("away", now, at(3)), { from: Date.parse(at(3)), to: Infinity });
  assert.deepEqual(overviewSpan("away", now, null), { from: week, to: Infinity }, "before their first look, the whole week");
  assert.deepEqual(overviewSpan("away", now, at(24 * 30)), { from: week, to: Infinity }, "never further back than results are kept");
});

test("a problem waits until it is handled; what merely happened is listed for the range", () => {
  const overview = { seenAt: at(5),
    results: [result("a", 9, "shipped", 1), result("b", 4, "problem", 2), result("a", 8, "problem", 30),
      result("c", 2, "decided", 40), result("c", 1, "problem", 50), result("d", 3, "problem", 60)],
    handled: [{ pageId: "c", revision: 1, conversationId: null, at: at(1) },
      { pageId: "d", revision: 3, conversationId: "conversation-1", at: at(1) }] };
  const keys = (items) => items.map(resultKey);
  const away = overviewLists(overview, "away", now);
  assert.deepEqual(keys(away.problems), ["b:4", "a:8"], "an old problem is still listed, a checked-off one is not");
  assert.deepEqual(away.moving.map((item) => [resultKey(item.result), item.conversationId]), [["d:3", "conversation-1"]],
    "one they answered is in motion, with where they answered");
  assert.deepEqual(keys(away.happened), ["a:9"], "only what came after they last saw");
  assert.deepEqual(keys(overviewLists(overview, "week", now).happened), ["a:9", "c:2"]);
  assert.deepEqual(keys(overviewLists(overview, "yesterday", now).happened), ["c:2"]);
  assert.deepEqual(keys(overviewLists({ ...overview, seenAt: null }, "away", now).happened), ["a:9", "c:2"]);
});

test("leaving moves what the reader has seen to the newest result they were shown, never back", () => {
  assert.equal(overviewSeenThrough(at(5), [result("a", 1, "shipped", 3), result("a", 2, "fixed", 1)]), at(1));
  assert.equal(overviewSeenThrough(at(1), [result("a", 1, "shipped", 3)]), null);
  assert.equal(overviewSeenThrough(null, [result("a", 1, "shipped", 3)]), at(3));
  assert.equal(overviewSeenThrough(at(5), []), null);
});

test("a conversation that waits on the reader is listed once: a request's card is that conversation's wait", () => {
  const channel = (id, count, lastMessageId) => ({ id, attention: { unreadAttentionCount: count, lastMessageId } });
  const channels = [channel("quiet", 0), channel("declared", 1, "m-1"), channel("card", 1, "norn:r1:1"),
    channel("both", 2, "norn:r2:1"), channel("card-then-wait", 1, "m-9"), { id: "none" }];
  const requests = [{ channelId: "card", messageId: "norn:r1:1" }, { channelId: "both", messageId: "norn:r2:1" },
    { channelId: "card-then-wait", messageId: "norn:r3:1" }];
  assert.deepEqual(overviewWaits(channels, requests).map((item) => item.id), ["declared", "both", "card-then-wait"]);
  assert.deepEqual(overviewWaits(channels, []).map((item) => item.id), ["declared", "card", "both", "card-then-wait"]);
  assert.equal(overviewAttentionKey(channels), "declared:1:m-1|card:1:norn:r1:1|both:2:norn:r2:1|card-then-wait:1:m-9");
  assert.notEqual(overviewAttentionKey(channels), overviewAttentionKey([...channels, channel("new", 1, "m-2")]));
  assert.equal(overviewAttentionKey([channel("quiet", 0), { id: "none" }]), "");
});

test("what the reader handled here keeps its place after the list lets it go", () => {
  const keyOf = (item) => item.id;
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => ({ id }));
  const handled = (...entries) => new Map(entries.map(([item, after]) => [item.id, { item, after }]));
  const ids = (items) => items.map(keyOf).join("");
  assert.equal(ids(overviewKept([a, b, c], keyOf, new Map())), "abc");
  assert.equal(ids(overviewKept([a, b, c], keyOf, handled([b, "a"]))), "abc", "still listed: it stands once");
  assert.equal(ids(overviewKept([a, c], keyOf, handled([b, "a"]))), "abc");
  assert.equal(ids(overviewKept([b, c], keyOf, handled([a, null]))), "abc", "the first stays first");
  assert.equal(ids(overviewKept([c], keyOf, handled([b, "a"], [a, null]))), "abc", "handled in any order");
  assert.equal(ids(overviewKept([c], keyOf, handled([a, null], [b, "a"]))), "abc");
  assert.equal(ids(overviewKept([d, a, c], keyOf, handled([b, "a"]))), "dabc", "what arrives meanwhile takes its own place");
  assert.equal(ids(overviewKept([], keyOf, handled([a, null], [b, "a"], [c, "b"]))), "abc", "a list worked to its end");
});

test("the tree key moves with a page's head and with its summary, which a result is written with", () => {
  const pages = [{ headRevision: 3, summary: { revision: 3 } }, { headRevision: 7, summary: null }];
  const key = overviewTreeKey(pages);
  assert.equal(overviewTreeKey([...pages]), key);
  assert.notEqual(overviewTreeKey([pages[0], { headRevision: 8, summary: null }]), key);
  assert.notEqual(overviewTreeKey([pages[0], { headRevision: 7, summary: { revision: 7 } }]), key);
  assert.notEqual(overviewTreeKey([pages[0]]), key);
});

test("a result's Agent is the one that made the change, by its address", () => {
  assert.equal(resultAgent({ authors: [{ kind: "user", id: "u", label: "Daniel" }, { kind: "agent", id: "i", label: "codex:2" }] }), "codex:2");
  assert.equal(resultAgent({ authors: [{ kind: "user", id: "u", label: "Daniel" }] }), null);
});
