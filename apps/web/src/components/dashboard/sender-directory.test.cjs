const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { decodeChannelSnapshot, presenceInstanceId } = require("@xmatrix/protocol");
const { createRealtimeChannels } = require("./instance-store.ts");
const { createSenderDirectory } = require("./realtime-channels.tsx");

const registration = { ownerUserId: "owner", machineId: "machine", harness: "codex" };
const record = (sequence, extra = {}) => ({ id: "channel:1", channelId: "channel", channelInstanceId: "1",
  label: "codex:1", agentName: "codex", registration, status: "busy", hostName: "build-box",
  connectedAt: "2026-11-06T18:00:00Z", lastSeenAt: "2026-11-06T18:00:01Z",
  revision: { version: 1, sequence }, ...extra });
const window = (records) => decodeChannelSnapshot({ id: "channel", name: "Channel", instanceRecords: records,
  memberPresence: {} });
const id = presenceInstanceId("channel:1");

test("a sender the rows named before its record arrived is known once read again", () => {
  const store = createRealtimeChannels([window([])]);
  const directory = createSenderDirectory();
  const catalog = store.getCatalog("channel");
  assert.equal(directory.read(catalog, store.get("channel")).presence.instances.size, 0);
  assert.equal(directory.knows("channel", "channel:1"), false);
  store.instances.receive([record(1)], "channel");
  const view = directory.read(catalog, store.get("channel"));
  assert.equal(view.presence.instances.get(id).hostName, "build-box");
  assert.equal(directory.knows("channel", "channel:1"), true);
});

test("status, rest, reconnect and absence leave the directory as it was; a departed sender stays", () => {
  const store = createRealtimeChannels([window([record(1)])]);
  const directory = createSenderDirectory();
  const catalog = store.getCatalog("channel");
  const first = directory.read(catalog, store.get("channel"));
  store.instances.receive([record(2, { status: "idle" })], "channel");
  assert.equal(directory.read(catalog, store.get("channel")), first);
  store.instances.receive([record(3, { status: "offline", rest: "sleeping", connectedAt: "2026-11-06T19:00:00Z" })], "channel");
  assert.equal(directory.read(catalog, store.get("channel")), first);
  store.instances.reconcileMissing(["channel:1"], new Map([["channel:1", store.instances.get("channel:1")]]));
  assert.equal(store.get("channel").presence.instances.size, 0);
  assert.equal(directory.read(catalog, store.get("channel")), first);
  store.instances.receive([record(4, { hostName: "laptop" })], "channel");
  assert.equal(directory.read(catalog, store.get("channel")).presence.instances.get(id).hostName, "laptop");
});

test("another Channel starts an empty directory", () => {
  const store = createRealtimeChannels([window([record(1)]),
    decodeChannelSnapshot({ id: "other", name: "Other", instanceRecords: [], memberPresence: {} })]);
  const directory = createSenderDirectory();
  directory.read(store.getCatalog("channel"), store.get("channel"));
  assert.equal(directory.read(store.getCatalog("other"), store.get("other")).presence.instances.size, 0);
  assert.equal(directory.knows("other", "channel:1"), false);
});
