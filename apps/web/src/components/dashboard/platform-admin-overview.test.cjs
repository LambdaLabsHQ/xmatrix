const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");
const overview = compileTsModules(__dirname, ["platform-admin-overview", "time-display"]);

const {
  adminActivityBars,
  agentMessageShare,
  filterAdminSpaces,
  filterAdminUsers,
  formatAdminAge,
  formatAdminBytes,
  formatAdminCount,
  platformAdminStatTiles,
  sortAdminSpaces,
  sortAdminUsers,
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

test("space sorting is stable and ranks by the selected column", () => {
  const spaces = [
    space({ id: "space:a", name: "Alpha", messages: 10, members: 3, activeChannels: 1, lastMessageAt: "2026-08-01T00:00:00.000Z" }),
    space({ id: "space:b", name: "Bravo", messages: 50, members: 1, activeChannels: 9, lastMessageAt: "2026-08-03T00:00:00.000Z" }),
    space({ id: "space:c", name: "Charlie", messages: 50, members: 2, activeChannels: 4 }),
  ];
  assert.deepEqual(sortAdminSpaces(spaces, "messages").map((item) => item.id), ["space:b", "space:c", "space:a"]);
  assert.deepEqual(sortAdminSpaces(spaces, "members").map((item) => item.id), ["space:a", "space:c", "space:b"]);
  assert.deepEqual(sortAdminSpaces(spaces, "channels").map((item) => item.id), ["space:b", "space:c", "space:a"]);
  assert.deepEqual(sortAdminSpaces(spaces, "name").map((item) => item.id), ["space:a", "space:b", "space:c"]);
  // "recent" falls back to createdAt when a Space has never carried a message.
  assert.equal(sortAdminSpaces(spaces, "recent")[0].id, "space:b");
  assert.equal(sortAdminSpaces(spaces, "messages")[0].id, "space:b");
  // Sorting never mutates the caller's array.
  assert.deepEqual(spaces.map((item) => item.id), ["space:a", "space:b", "space:c"]);
});

test("search matches name, id, owner email, and owner id", () => {
  const spaces = [
    space({ id: "space:a", name: "Alpha", ownerEmail: "ops@example.com" }),
    space({ id: "space:b", name: "Bravo", ownerUserId: "user:zed" }),
  ];
  assert.deepEqual(filterAdminSpaces(spaces, "  ").map((item) => item.id), ["space:a", "space:b"]);
  assert.deepEqual(filterAdminSpaces(spaces, "alpha").map((item) => item.id), ["space:a"]);
  assert.deepEqual(filterAdminSpaces(spaces, "OPS@EXAMPLE").map((item) => item.id), ["space:a"]);
  assert.deepEqual(filterAdminSpaces(spaces, "zed").map((item) => item.id), ["space:b"]);
  assert.deepEqual(filterAdminSpaces(spaces, "space:b").map((item) => item.id), ["space:b"]);

  const users = [
    { userId: "user:1", name: "Operator", handle: "ops", email: "ops@example.com", providers: ["github"], spaces: 1, ownedSpaces: 1, agentRegistrations: 0, machines: 0, messages: 0 },
    { userId: "user:2", spaces: 1, ownedSpaces: 0, agentRegistrations: 0, machines: 0, messages: 0 },
  ];
  assert.deepEqual(filterAdminUsers(users, "ops").map((item) => item.userId), ["user:1"]);
  assert.deepEqual(filterAdminUsers(users, "github").map((item) => item.userId), ["user:1"]);
  assert.deepEqual(filterAdminUsers(users, "user:2").map((item) => item.userId), ["user:2"]);
});

test("user sorting covers access, registration, and engagement dimensions", () => {
  const users = [
    { userId: "user:a", email: "a@example.com", spaces: 3, ownedSpaces: 1, agentRegistrations: 0, machines: 0, messages: 4, sessionCount: 2, registeredAt: "2026-08-01T00:00:00.000Z" },
    { userId: "user:b", email: "b@example.com", spaces: 1, ownedSpaces: 1, agentRegistrations: 0, machines: 0, messages: 8, sessionCount: 5, registeredAt: "2026-08-03T00:00:00.000Z", lastSessionAt: "2026-08-04T00:00:00.000Z" },
  ];
  assert.deepEqual(sortAdminUsers(users, "recent").map((item) => item.userId), ["user:b", "user:a"]);
  assert.deepEqual(sortAdminUsers(users, "registered").map((item) => item.userId), ["user:b", "user:a"]);
  assert.deepEqual(sortAdminUsers(users, "sessions").map((item) => item.userId), ["user:b", "user:a"]);
  assert.deepEqual(sortAdminUsers(users, "messages").map((item) => item.userId), ["user:b", "user:a"]);
  assert.deepEqual(sortAdminUsers(users, "spaces").map((item) => item.userId), ["user:a", "user:b"]);
});
