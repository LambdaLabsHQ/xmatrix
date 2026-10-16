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
