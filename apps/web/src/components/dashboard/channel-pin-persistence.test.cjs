const { readDashboardSource } = require("./source-scan-fixture.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { readPins, savePin } = require("./channel-pins-client.ts");

/** A fake Authority: GET returns the record, PATCH answers with the next status in line. */
function authority(record, patchStatuses = []) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || "GET", body });
    if (!init.method) return { ok: true, status: 200, json: async () => record };
    const status = patchStatuses.shift() ?? 200;
    return { ok: status < 400, status, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

test("Authority is the authority for pinned channels, so the read projects whatever it returns", async () => {
  const { fetchImpl } = authority({ pinnedChannelIds: ["b", "", 7, "a", "b"], version: 4 });
  assert.deepEqual(await readPins({ token: "t", spaceId: "s", fetchImpl }),
    { pinnedChannelIds: ["b", "a"], version: 4 }, "malformed ids drop and duplicates collapse, first-seen order kept");
});

test("a pin goes first and an unpin of the last channel sends an empty list", async () => {
  const pin = authority({ pinnedChannelIds: ["a"], version: 1 });
  await savePin({ token: "t", spaceId: "s", change: { channelId: "b", pinned: true }, fetchImpl: pin.fetchImpl });
  assert.deepEqual(pin.calls[1].body, { expectedVersion: 1, pinnedChannelIds: ["b", "a"] });
  const unpin = authority({ pinnedChannelIds: ["a"], version: 2 });
  await savePin({ token: "t", spaceId: "s", change: { channelId: "a", pinned: false }, fetchImpl: unpin.fetchImpl });
  assert.deepEqual(unpin.calls[1].body, { expectedVersion: 2, pinnedChannelIds: [] });
});

test("a conflict rebases once on a fresh read; repeated conflicts and other failures stop", async () => {
  const once = authority({ pinnedChannelIds: [], version: 3 }, [409, 200]);
  await savePin({ token: "t", spaceId: "s", change: { channelId: "a", pinned: true }, fetchImpl: once.fetchImpl });
  assert.deepEqual(once.calls.map((call) => call.method), ["GET", "PATCH", "GET", "PATCH"]);
  const twice = authority({ pinnedChannelIds: [], version: 3 }, [409, 409]);
  await assert.rejects(savePin({ token: "t", spaceId: "s", change: { channelId: "a", pinned: true },
    fetchImpl: twice.fetchImpl }));
  assert.equal(twice.calls.filter((call) => call.method === "PATCH").length, 2);
  const failed = authority({ pinnedChannelIds: [], version: 3 }, [500]);
  await assert.rejects(savePin({ token: "t", spaceId: "s", change: { channelId: "a", pinned: true },
    fetchImpl: failed.fetchImpl }));
  assert.equal(failed.calls.filter((call) => call.method === "PATCH").length, 1);
});

test("channel pins are never stored in the browser", () => {
  /* A pin used to live only in `localStorage`, where a compaction pass deleted
     every pin whenever the in-memory channel list was momentarily incomplete
     during load. Authority owns pins now; a second browser-local copy could only
     bring that deletion back. */
  const modules = [
    "workspace-shell-helpers-extra.tsx",
    "workspace-shell-constants.ts",
    "use-workspace-shell-state.ts",
    "use-workspace-shell-actions.ts",
    "workspace-shell-recovered.tsx",
  ];
  for (const basename of modules) {
    const source = readDashboardSource(basename);
    assert.doesNotMatch(
      source,
      /channel-pin-state|readChannelPinState|writeChannelPinState|channelPinStateStorageKey/,
      `${basename} must not keep a browser-local copy of channel pins`
    );
    assert.doesNotMatch(
      source,
      /compactChannelPinState/,
      `${basename} must not drop pins for channels missing from the current list`
    );
  }
});
