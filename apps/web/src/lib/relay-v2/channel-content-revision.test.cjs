const assert = require("node:assert/strict");
const test = require("node:test");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const {
  channelCatalogContentRevision,
  latestChannelContentRevision,
  noteChannelContentRevision,
  parseChannelContentRevision,
} = require("./channel-content-revision.ts");

test("parsing accepts only protocol version 1 with a safe non-negative revision", () => {
  assert.equal(parseChannelContentRevision({ protocolVersion: 1, contentRevision: 0 }), 0);
  assert.equal(parseChannelContentRevision({ protocolVersion: 1, contentRevision: 42 }), 42);
  assert.equal(parseChannelContentRevision({ protocolVersion: 2, contentRevision: 42 }), undefined);
  assert.equal(parseChannelContentRevision({ protocolVersion: 1, contentRevision: -1 }), undefined);
  assert.equal(parseChannelContentRevision({ protocolVersion: 1, contentRevision: 1.5 }), undefined);
  assert.equal(parseChannelContentRevision({ protocolVersion: 1 }), undefined);
  assert.equal(parseChannelContentRevision(undefined), undefined);
  assert.equal(parseChannelContentRevision("7"), undefined);
});

test("the catalog row reader applies the same strict parse; absence is no signal", () => {
  assert.equal(
    channelCatalogContentRevision({ contentAuthority: { protocolVersion: 1, contentRevision: 7 } }),
    7,
  );
  assert.equal(channelCatalogContentRevision({}), undefined);
  assert.equal(
    channelCatalogContentRevision({ contentAuthority: { protocolVersion: 2, contentRevision: 7 } }),
    undefined,
  );
});

test("the registry keeps the newest noted revision per channel", () => {
  // Unique ids per assertion group: the registry is session-global by design.
  assert.equal(latestChannelContentRevision("registry-a"), undefined);
  noteChannelContentRevision("registry-a", undefined);
  assert.equal(latestChannelContentRevision("registry-a"), undefined);
  noteChannelContentRevision("registry-a", 5);
  noteChannelContentRevision("registry-b", 9);
  assert.equal(latestChannelContentRevision("registry-a"), 5);
  assert.equal(latestChannelContentRevision("registry-b"), 9);
  noteChannelContentRevision("registry-a", 6);
  assert.equal(latestChannelContentRevision("registry-a"), 6);
});
