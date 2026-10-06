import assert from "node:assert/strict";

import test from "node:test";

import {
  decodeChannelCatalogSyncToken,
  encodeChannelCatalogSyncToken,
  planChannelCatalogDelta,
} from "../src/channel-catalog-sync-token.ts";

test("catalog sync tokens round-trip a sorted bounded revision vector", () => {
  const encoded = encodeChannelCatalogSyncToken(new Map([["space-b", 7], ["space-a", 3]]));
  assert.equal(typeof encoded, "string");
  assert.equal(encoded.includes("space-a"), false, "the URL cursor must not expose Space ids");
  assert.deepEqual([...decodeChannelCatalogSyncToken(encoded)], [["space-a", 3], ["space-b", 7]]);
});

test("catalog sync tokens reject ambiguous or unbounded input", () => {
  assert.equal(decodeChannelCatalogSyncToken("not-json"), undefined);
  const outOfOrder = Buffer.from(JSON.stringify({
    v: 1, spaces: [["space-b", 1], ["space-a", 2]],
  })).toString("base64url");
  assert.equal(decodeChannelCatalogSyncToken(outOfOrder), undefined,
    "the canonical order is part of the token contract");
  const duplicate = Buffer.from(JSON.stringify({
    v: 1, spaces: [["space-a", 1], ["space-a", 2]],
  })).toString("base64url");
  assert.equal(decodeChannelCatalogSyncToken(duplicate), undefined,
    "duplicate Space ids are ambiguous");
  assert.equal(encodeChannelCatalogSyncToken(new Map(
    Array.from({ length: 97 }, (_, index) => [`space-${index}`, index]),
  )), undefined);
});

test("delta planning replaces changed/new Spaces and explicitly removes departed Spaces", () => {
  assert.deepEqual(
    planChannelCatalogDelta(
      new Map([["removed", 1], ["same", 2], ["changed", 3]]),
      new Map([["same", 2], ["changed", 4], ["new", 1]]),
    ),
    { replacedSpaceIds: ["changed", "new"], removedSpaceIds: ["removed"] },
  );
});
