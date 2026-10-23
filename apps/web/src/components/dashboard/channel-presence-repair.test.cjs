const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { ChannelPresenceConflict, decodeChannelCatalogPage } = require("@xmatrix/protocol");
const { createChannelPresenceRepair } = require("./channel-presence-repair.ts");

test("conflicts request one repair per Instance; a broken authoritative response never feeds a retry loop", t => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const requested = [];
  const repair = createChannelPresenceRepair(id => {
    requested.push(id);
    const page = decodeChannelCatalogPage({ rows: [{ channel: { id, memberPresence: {
      invalid: { kind: "agent", instances: [{ id: "a" }] },
    } } }] });
    assert.equal(page.rows[0].channel.presence, undefined);
  });
  for (let index = 0; index < 100; index++) repair(new ChannelPresenceConflict("channel", "first"));
  repair(new Error("invalid authoritative response"));
  repair(new ChannelPresenceConflict("channel", "second"));
  repair(new ChannelPresenceConflict("other", "first"));
  assert.deepEqual(requested, ["channel", "channel", "other"]);
});

test("a first read before commit permits another report to repair, with bounded attempts and eviction", t => {
  t.mock.method(console, "warn", () => {});
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const requests = [];
  const repair = createChannelPresenceRepair(id => requests.push(id));
  const missing = new ChannelPresenceConflict("channel", "instance");
  repair(missing); // The first authoritative response has no Instance yet.
  repair(missing); // Repeated frames during that read are coalesced.
  now = 1_001;
  repair(missing);
  assert.deepEqual(requests, ["channel", "channel"]);
  for (let index = 0; index < 100; index++) { now += 1_001; repair(missing); }
  assert.equal(requests.length, 3);
  for (let index = 0; index < 600; index++) repair(new ChannelPresenceConflict("channel", `new-${index}`));
  assert.equal(requests.length, 603, "a long-lived tab can still repair new Instances");
  now += 300_001;
  repair(missing);
  assert.equal(requests.length, 604, "old repair records expire");
});
