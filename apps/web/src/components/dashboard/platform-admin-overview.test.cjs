const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");
const overview = compileTsModules(__dirname, ["platform-admin-overview", "time-display"]);

const {
  adminActivityBars,
  agentMessageShare,
  adminTableCsv,
  adminTime,
  formatAdminAge,
  formatAdminBytes,
  formatAdminCount,
  platformAdminStatTiles,
  sortAdminRows,
} = overview.exports;

test.after(overview.dispose);

function space(overrides) {
  return {
    id: "space:1",
    name: "Space",
    ownerUserId: "user:1",
    members: 1,
    channels: 1,
    activeChannels: 1,
    agentRegistrations: 0,
    messages: 0,
    messagesLast7d: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("counts and bytes stay readable at every magnitude", () => {
  assert.equal(formatAdminCount(0), "0");
  assert.equal(formatAdminCount(999), "999");
  assert.equal(formatAdminCount(1000), "1k");
  assert.equal(formatAdminCount(15_400), "15.4k");
  assert.equal(formatAdminCount(2_500_000), "2.5M");
  assert.equal(formatAdminBytes(0), "0 B");
  assert.equal(formatAdminBytes(512), "512 B");
  assert.equal(formatAdminBytes(1024), "1 KB");
  assert.equal(formatAdminBytes(1024 * 1024 * 3.5), "3.5 MB");
});

test("relative age degrades from minutes to an absolute date", () => {
  const now = Date.parse("2026-08-04T12:00:00.000Z");
  assert.equal(formatAdminAge(undefined, now), "");
  assert.equal(formatAdminAge("not-a-date", now), "");
  assert.equal(formatAdminAge("2026-08-04T11:59:30.000Z", now), "just now");
  assert.equal(formatAdminAge("2026-08-04T11:30:00.000Z", now), "30m ago");
  assert.equal(formatAdminAge("2026-08-04T06:00:00.000Z", now), "6h ago");
  assert.equal(formatAdminAge("2026-08-01T12:00:00.000Z", now), "3d ago");
  /* Past a month the age becomes a calendar date, and a calendar date is not
     the reader's — it is the UTC one the row was stored under, so it says so
     rather than letting a reader in another zone read it as local. */
  assert.equal(formatAdminAge("2026-01-01T12:00:00.000Z", now), "2026-01-01 UTC");
});

test("stat tiles summarize the platform totals without dropping a metric", () => {
  const tiles = platformAdminStatTiles({
    users: 12,
    spaces: 9,
    channels: 30,
    activeChannels: 25,
    archivedChannels: 5,
    messages: 4200,
    messagesLast24h: 120,
    messagesLast7d: 900,
    humanMessages: 1200,
    agentMessages: 3000,
    agentRegistrations: 7,
    runs: 40,
    activeRuns: 2,
    agentInstances: 3,
    machines: 6,
    onlineMachines: 4,
    scheduledTasks: 8,
    enabledScheduledTasks: 5,
    storageLogicalBytes: 1024 * 1024,
    archivedSegmentBytes: 2048,
  });
  const byKey = Object.fromEntries(tiles.map((tile) => [tile.key, tile]));
  assert.equal(byKey.users.value, "12");
  assert.equal(byKey.users.hint, "9 spaces");
  assert.equal(byKey.messages.value, "4.2k");
  assert.equal(byKey.messages.hint, "120 in 24h");
  assert.equal(byKey.machines.value, "4");
  assert.equal(byKey.storage.value, "1 MB");
});

test("agent share is attributed-only and safe when nothing has been sent", () => {
  assert.equal(agentMessageShare({ humanMessages: 0, agentMessages: 0 }), 0);
  assert.equal(agentMessageShare({ humanMessages: 25, agentMessages: 75 }), 0.75);
});

test("activity bars scale against the busiest day and keep empty days", () => {
  const bars = adminActivityBars([
    { date: "2026-08-01", messages: 0, humanMessages: 0, agentMessages: 0 },
    { date: "2026-08-02", messages: 5, humanMessages: 2, agentMessages: 3 },
    { date: "2026-08-03", messages: 10, humanMessages: 4, agentMessages: 6 },
  ]);
  assert.deepEqual(bars.map((bar) => bar.ratio), [0, 0.5, 1]);
  assert.deepEqual(bars.map((bar) => bar.label), ["08-01", "08-02", "08-03"]);

  const flat = adminActivityBars([
    { date: "2026-08-01", messages: 0, humanMessages: 0, agentMessages: 0 },
  ]);
  assert.equal(flat[0].ratio, 0);
});

test("table sorting is stable, either direction, and keeps missing values last", () => {
  const rows = [
    space({ id: "space:a", name: "Alpha", messages: 10, lastMessageAt: "2026-08-01T00:00:00.000Z" }),
    space({ id: "space:b", name: "Bravo", messages: 50, lastMessageAt: "2026-08-03T00:00:00.000Z" }),
    space({ id: "space:c", name: "Charlie", messages: 50 }),
  ];
  const messages = { key: "messages", label: "Messages", value: (row) => row.messages };
  const name = { key: "name", label: "Space", value: (row) => row.name };
  const last = { key: "last", label: "Last", value: (row) => adminTime(row.lastMessageAt) };
  assert.deepEqual(sortAdminRows(rows, messages, true).map((row) => row.id), ["space:b", "space:c", "space:a"]);
  assert.deepEqual(sortAdminRows(rows, name, false).map((row) => row.id), ["space:a", "space:b", "space:c"]);
  assert.deepEqual(sortAdminRows(rows, last, true).map((row) => row.id), ["space:b", "space:a", "space:c"]);
  assert.deepEqual(sortAdminRows(rows, last, false).map((row) => row.id), ["space:a", "space:b", "space:c"]);
  // An unsortable column keeps the given order, and the caller's array is never mutated.
  assert.deepEqual(sortAdminRows(rows, { key: "x", label: "X" }, true).map((row) => row.id), ["space:a", "space:b", "space:c"]);
  assert.deepEqual(rows.map((row) => row.id), ["space:a", "space:b", "space:c"]);
});

test("CSV export quotes, escapes, and neutralises spreadsheet formulas", () => {
  const columns = [
    { key: "name", label: "Name", value: (row) => row.name },
    { key: "count", label: "Count", value: (row) => row.count },
    { key: "skip", label: "Skip", value: (row) => row.name, noExport: true },
    { key: "view", label: "View only" },
  ];
  assert.equal(
    adminTableCsv([
      { name: "plain", count: 1 },
      { name: "a, \"quoted\" name", count: 2 },
      { name: "=HYPERLINK(1)", count: undefined },
    ], columns),
    'Name,Count\nplain,1\n"a, ""quoted"" name",2\n\'=HYPERLINK(1),',
  );
});
