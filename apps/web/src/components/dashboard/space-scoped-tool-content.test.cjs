const assert = require("node:assert/strict");

const path = require("node:path");
const test = require("node:test");
const { installTypeScriptRequire } = require("./typescript-require.cjs");
installTypeScriptRequire();

const {
  channelsInSpace,
  eventsInSpace,
  localManagedAgentsInSpace,
  machinesInSpace,
  automationsInSpace,
  spaceChannelIdSet,
  workspacesInSpace,
} = require(path.join(__dirname, "space-scoped-tool-content.ts"));

const SPACE = "space-team";
const OTHER = "space-other";
const channels = [
  { id: "ch-a", spaceId: SPACE },
  { id: "ch-b", spaceId: SPACE },
  { id: "ch-c", spaceId: OTHER },
];

test("channel ids for the current Space exclude every other Space", () => {
  const ids = spaceChannelIdSet(channels, SPACE);
  assert.deepEqual([...ids].sort(), ["ch-a", "ch-b"]);
  assert.deepEqual(channelsInSpace(channels, SPACE).map((channel) => channel.id), ["ch-a", "ch-b"]);
  assert.deepEqual(channelsInSpace(channels, null), []);
});

test("Schedules hide another Space's tasks and keep a task whose Channel is gone", () => {
  const tasks = [
    { id: "t-a", channelId: "ch-a" },
    { id: "t-c", channelId: "ch-c" },
    { id: "t-missing", channelId: "ch-gone" },
  ];
  const known = new Set(channels.map((channel) => channel.id));
  // `t-missing` belongs to no Space at all. Dropping it would leave a running
  // schedule with no surface that can edit or delete it, which is the state the
  // editor's `(unavailable)` Channel option exists to repair.
  assert.deepEqual(
    automationsInSpace(tasks, spaceChannelIdSet(channels, SPACE), known).map((task) => task.id),
    ["t-a", "t-missing"],
  );
});

test("Activity keeps this Space's events and the ones that name no Space", () => {
  const events = [
    { id: "e-a", type: "agent_connected", workspaceUserId: "u1", channelId: "ch-a", timestamp: "1" },
    { id: "e-c", type: "agent_connected", workspaceUserId: "u1", channelId: "ch-c", timestamp: "2" },
    {
      id: "e-meta",
      type: "space_management_action_executed",
      workspaceUserId: "u1",
      metadata: { spaceId: SPACE },
      timestamp: "3",
    },
    {
      id: "e-other-meta",
      type: "space_management_action_executed",
      workspaceUserId: "u1",
      metadata: { spaceId: OTHER },
      timestamp: "4",
    },
    { id: "e-global", type: "agent_connected", workspaceUserId: "u1", timestamp: "5" },
  ];
  // `e-global` is an Agent connecting: no Channel, no Space. Hiding it would
  // remove it from every Space, so it stays wherever the reader is standing.
  assert.deepEqual(
    eventsInSpace(events, SPACE, spaceChannelIdSet(channels, SPACE)).map((event) => event.id),
    ["e-a", "e-meta", "e-global"],
  );
  assert.deepEqual(
    eventsInSpace(events, null, new Set()).map((event) => event.id),
    ["e-global"],
  );
});

test("This Machine keeps unbound directories and current-Space bindings", () => {
  const workspaces = [
    { boundChannelIds: [] },
    { boundChannelIds: ["ch-a"] },
    { boundChannelIds: ["ch-c"] },
  ];
  const ids = spaceChannelIdSet(channels, SPACE);
  assert.equal(workspacesInSpace(workspaces, ids, { includeUnbound: true }).length, 2);
  assert.equal(workspacesInSpace(workspaces, ids).length, 1);
});

test("Machines drop hosts that only have other-Space directories", () => {
  const machines = [
    { id: "here", workspaces: [{ boundChannelIds: ["ch-a"] }, { boundChannelIds: ["ch-c"] }] },
    { id: "elsewhere", workspaces: [{ boundChannelIds: ["ch-c"] }] },
    { id: "unbound", workspaces: [{ boundChannelIds: [] }] },
    { id: "empty", workspaces: [] },
  ];
  const scoped = machinesInSpace(machines, spaceChannelIdSet(channels, SPACE));
  assert.deepEqual(scoped.map((machine) => machine.id), ["here", "unbound"]);
  assert.deepEqual(scoped[0].workspaces, [{ boundChannelIds: ["ch-a"] }]);
  assert.deepEqual(scoped[1].workspaces, [{ boundChannelIds: [] }]);
});

test("This Machine lists only this Space's registrations", () => {
  const agents = [
    { id: "here", registration: { key: { spaceId: SPACE } } },
    { id: "elsewhere", registration: { key: { spaceId: OTHER } } },
  ];
  assert.deepEqual(
    localManagedAgentsInSpace(agents, SPACE).map((agent) => agent.id),
    ["here"],
  );
  assert.deepEqual(localManagedAgentsInSpace(agents, null), []);
});

test("owned Machines stay manageable without leaking other Spaces' directories", () => {
  const machines = [
    { id: "empty-owned", daemon: { userId: "owner" }, workspaces: [] },
    { id: "other-space-owned", daemon: { userId: "owner" }, workspaces: [{ boundChannelIds: ["ch-c"] }] },
    { id: "other-owner", daemon: { userId: "another-owner" }, workspaces: [] },
  ];
  const scoped = machinesInSpace(machines, spaceChannelIdSet(channels, SPACE), { ownerUserId: "owner" });
  assert.deepEqual(scoped.map(machine => machine.id), ["empty-owned", "other-space-owned"]);
  assert.deepEqual(scoped.map(machine => machine.workspaces), [[], []]);
});
