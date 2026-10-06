const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  groupSchedules, scheduleAttention, scheduleState, scheduleSummary, sectionFallbackTitle,
} = require("./schedules-model.ts");

function automation(overrides) {
  return {
    id: "a", name: "A", channelId: "c-a", enabled: true, nextRunAt: "2026-09-28T12:00:00.000Z",
    intervalMinutes: 60, capabilities: {}, ...overrides,
  };
}

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
