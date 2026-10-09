const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  groupSchedules, nameUnderPage, scheduleAttention, scheduleState, scheduleSummary, scheduleTree, sectionFallbackTitle,
} = require("./schedules-model.ts");

function automation(overrides) {
  return {
    id: "a", name: "A", channelId: "c-a", enabled: true, nextRunAt: "2026-09-28T12:00:00.000Z",
    intervalMinutes: 60, capabilities: {}, ...overrides,
  };
}

function tree(list, pages, sections = {}) {
  const childrenOf = new Map();
  for (const page of pages) {
    const parent = page.parentPageId ?? null;
    childrenOf.set(parent, [...childrenOf.get(parent) ?? [], page]);
  }
  return scheduleTree(list, childrenOf, (pageId) => sections[pageId] ?? [], true);
}

function shape(nodes) {
  return nodes.map((node) => node.kind === "page"
    ? [node.pageId, node.automations.map((item) => item.id), shape(node.children)]
    : [`#${node.channelId}`, node.automations.map((item) => item.id), []]);
}

test("Automations sit on the page tree: only pages that hold one and the pages above them, in tree order", () => {
  const pages = [
    { pageId: "root", title: "Root" },
    { pageId: "empty", title: "Empty", parentPageId: "root" },
    { pageId: "goals", title: "Goals", parentPageId: "root" },
    { pageId: "deep", title: "Deep", parentPageId: "goals" },
    { pageId: "other", title: "Other" },
  ];
  const nodes = tree([
    automation({ id: "d", pageId: "deep" }),
    automation({ id: "g", pageId: "goals", enabled: false }),
    automation({ id: "lost", pageId: "unreadable" }),
    automation({ id: "chat", channelId: "c-old" }),
  ], pages);
  assert.deepEqual(shape(nodes), [
    ["root", [], [["goals", ["g"], [["deep", ["d"], []]]]]],
    ["unreadable", ["lost"], []],
    ["#c-old", ["chat"], []],
  ]);
  assert.deepEqual(nodes[0].counts, { attention: 0, running: 1, paused: 1 });
  assert.equal(nodes[1].title, null);
});

test("a page's Automations follow its sections from the top, then by name", () => {
  const nodes = tree([
    automation({ id: "z", name: "Zeta", pageId: "p" }),
    automation({ id: "late", name: "Alpha", pageId: "p", blockId: "second" }),
    automation({ id: "early", name: "Beta", pageId: "p", blockId: "first" }),
    automation({ id: "a", name: "Alpha", pageId: "p" }),
  ], [{ pageId: "p", title: "P" }], { p: ["first", "second"] });
  assert.deepEqual(nodes[0].automations.map((item) => item.id), ["early", "late", "a", "z"]);
});

test("Automations are grouped by what they are doing: attention, running, paused; empty states are left out", () => {
  const groups = groupSchedules([
    automation({ id: "off", name: "Off", enabled: false }),
    automation({ id: "broken", name: "Broken", lastError: "Channel is archived" }),
    automation({ id: "on", name: "On" }),
  ], true);
  assert.deepEqual(groups.map((group) => [group.state, group.automations.map((item) => item.id)]),
    [["attention", ["broken"]], ["running", ["on"]], ["paused", ["off"]]]);
  assert.deepEqual(groupSchedules([automation({ id: "on" })], true).map((group) => group.state), ["running"]);
});

test("running Automations come soonest first, paused ones by name, and detached ones need attention", () => {
  const groups = groupSchedules([
    automation({ id: "p2", name: "Zeta", enabled: false }),
    automation({ id: "late", name: "Late", nextRunAt: "2026-09-28T15:00:00.000Z" }),
    automation({ id: "p1", name: "Alpha", enabled: false }),
    automation({ id: "soon", name: "Soon", nextRunAt: "2026-09-28T13:00:00.000Z" }),
    automation({ id: "gone", name: "Gone", detachedAt: "2026-09-27T00:00:00.000Z" }),
  ], true);
  assert.deepEqual(groups.map((group) => [group.state, group.automations.map((item) => item.id)]),
    [["attention", ["gone"]], ["running", ["soon", "late"]], ["paused", ["p1", "p2"]]]);
});

test("attention names what a person has to look at, most urgent first", () => {
  assert.equal(scheduleAttention(automation({}), true), null);
  assert.match(scheduleAttention(automation({ detachedAt: "2026-09-27T00:00:00.000Z" }), true), /reference left/);
  assert.equal(scheduleAttention(automation({ latestExecution: { status: "failed", errorCode: "no_runtime" } }), true),
    "Its last run did not start: no_runtime");
  assert.equal(scheduleAttention(automation({ lastError: "Channel is archived" }), true),
    "Its last run failed: Channel is archived");
  assert.equal(scheduleAttention(automation({}), false), "Scheduled runs are unavailable");
  assert.equal(scheduleAttention(automation({ enabled: false }), false), null);
});

test("a detached Automation counts as paused, and the summary names the soonest running one", () => {
  const list = [
    automation({ id: "soon", pageId: "goals", nextRunAt: "2026-09-28T12:05:00.000Z" }),
    automation({ id: "later", pageId: "relay", nextRunAt: "2026-09-28T18:00:00.000Z" }),
    automation({ id: "gone", pageId: "relay", detachedAt: "2026-09-27T00:00:00.000Z", nextRunAt: "2026-09-28T11:00:00.000Z" }),
    automation({ id: "off", channelId: "c-old", enabled: false }),
  ];
  const summary = scheduleSummary(list, true);
  assert.deepEqual({ ...summary, next: summary.next.id },
    { total: 4, running: 2, paused: 2, attention: 1, pages: 2, next: "soon" });
  assert.deepEqual(list.map((item) => scheduleState(item, true)), ["running", "running", "attention", "paused"]);
});

test("a section's slug stands in for its title until the page is read", () => {
  assert.equal(sectionFallbackTitle("release-checklist"), "Release checklist");
  assert.equal(sectionFallbackTitle(""), "Top of the page");
});

test("under its page an Automation's name drops the page title it repeats", () => {
  assert.equal(nameUnderPage("xaccelerator.io 市场与用户", "xaccelerator.io"), "市场与用户");
  assert.equal(nameUnderPage("DeepMarket: weekly SEO", "deepmarket"), "weekly SEO");
  assert.equal(nameUnderPage("Docsify sync", "Docs"), "Docsify sync");
  assert.equal(nameUnderPage("DeepMarket", "DeepMarket"), "DeepMarket");
  assert.equal(nameUnderPage("市场与用户", undefined), "市场与用户");
});
