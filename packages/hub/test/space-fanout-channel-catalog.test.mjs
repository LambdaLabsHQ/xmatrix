import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readSpaceFanoutChannelCatalog,
} from "../src/space-fanout-channel-catalog.ts";

const NO_SPACES = Object.freeze({
  ok: true,
  channels: [],
  openChannelHumanMemberIdsBySpace: {},
});

function scope(scopeId, overrides = {}) {
  return {
    scopeId,
    grantVersion: 1,
    snapshotEpoch: 2,
    historyFloor: 0,
    historyTail: 9,
    purgeEpoch: 0,
    redactionEpoch: 0,
    changeHead: 9,
    redactionHead: 0,
    ...overrides,
  };
}

function manifest(scopes, authority = { authorizationEpoch: 4, entitlementDigest: "digest" }) {
  return { protocolVersion: 1, authority, scopes };
}

/** A directory of Spaces, each answering with its own Channels. */
function catalogSource(spaces) {
  return {
    listSpaceIds: async () => ({ ok: true, spaceIds: Object.keys(spaces) }),
    readSpaceCatalog: async (spaceId) => spaces[spaceId],
  };
}

function spaceCatalog(spaceId, channelIds, projectionCacheManifest) {
  return {
    ok: true,
    channels: channelIds.map((id) => ({ id, spaceId })),
    openChannelHumanMemberIdsBySpace: { [spaceId]: [`user-of-${spaceId}`] },
    ...(projectionCacheManifest ? { projectionCacheManifest } : {}),
  };
}

function readSpaceAFanout(second) {
  return readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    ...catalogSource({
      "space-a": spaceCatalog("space-a", ["channel-a1"], manifest([scope("channel:a")])),
      "space-b": second,
    }),
  });
}

test("every Space contributes, not only the first one that answers", async () => {
  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    ...catalogSource({
      "space-a": spaceCatalog("space-a", ["channel-a1", "channel-a2"]),
      "space-b": spaceCatalog("space-b", ["channel-b1"]),
    }),
  });

  assert.equal(result.ok, true);
  // The precise regression: a reader with Channels in the first Space used to
  // be handed that Space alone.
  assert.deepEqual(result.channels.map((channel) => channel.id), [
    "channel-a1",
    "channel-a2",
    "channel-b1",
  ]);
  // Spread first: the merged record is deliberately prototype-less.
  assert.equal(Object.getPrototypeOf(result.openChannelHumanMemberIdsBySpace), null);
  assert.deepEqual({ ...result.openChannelHumanMemberIdsBySpace }, {
    "space-a": ["user-of-space-a"],
    "space-b": ["user-of-space-b"],
  });
});

test("a Space named twice is read once", async () => {
  let reads = 0;
  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    listSpaceIds: async () => ({ ok: true, spaceIds: ["space-a", "space-b", "space-a"] }),
    readSpaceCatalog: async (spaceId) => {
      reads += 1;
      return spaceCatalog(spaceId, [`channel-of-${spaceId}`]);
    },
  });

  assert.equal(reads, 2);
  assert.deepEqual(result.channels.map((channel) => channel.id), [
    "channel-of-space-a",
    "channel-of-space-b",
  ]);
});

test("per-Space catalog revisions retain their routing identity", async () => {
  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    ...catalogSource({
      "space-a": { ...spaceCatalog("space-a", ["channel-a"]), catalogRevision: 7 },
      "space-b": { ...spaceCatalog("space-b", []), catalogRevision: 11 },
    }),
  });
  assert.deepEqual({ ...result.catalogRevisionsBySpace }, {
    "space-a": 7,
    "space-b": 11,
  });
});

test("an empty Space directory returns the caller's own empty catalog", async () => {
  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    listSpaceIds: async () => ({ ok: true, spaceIds: [] }),
    readSpaceCatalog: async () => assert.fail("no Space may be read"),
  });

  assert.equal(result, NO_SPACES);
});

test("an unreadable Space directory fails the whole catalog", async () => {
  const response = new Response("nope", { status: 503 });
  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    listSpaceIds: async () => ({ ok: false, response }),
    readSpaceCatalog: async () => assert.fail("no Space may be read"),
  });

  assert.deepEqual(result, { ok: false, response });
});

test("one unreadable Space fails the whole catalog instead of returning part of it", async () => {
  const response = new Response("nope", { status: 500 });
  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    ...catalogSource({
      "space-a": spaceCatalog("space-a", ["channel-a1"]),
      "space-b": { ok: false, response },
    }),
  });

  // A partial catalog is indistinguishable from the bug being fixed here.
  assert.equal(result.ok, false);
  assert.equal(result.response, response);
});

test("more Spaces than the concurrency bound are all read, eight at a time", async () => {
  const spaceIds = Array.from({ length: 21 }, (_, index) => `space-${index}`);
  let inFlight = 0;
  let peakInFlight = 0;
  const read = [];

  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    listSpaceIds: async () => ({ ok: true, spaceIds }),
    readSpaceCatalog: async (spaceId) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      read.push(spaceId);
      return spaceCatalog(spaceId, [`channel-of-${spaceId}`]);
    },
  });

  assert.equal(peakInFlight, 8);
  assert.deepEqual(read.slice().sort(), spaceIds.slice().sort());
  assert.equal(result.channels.length, 21);
});

test("consistent per-Space manifests merge into one de-duplicated ordered scope list", async () => {
  const shared = scope("space:shared");
  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    ...catalogSource({
      "space-a": spaceCatalog("space-a", ["channel-a1"], manifest([scope("channel:b"), shared])),
      "space-b": spaceCatalog("space-b", ["channel-b1"], manifest([scope("channel:a"), shared])),
    }),
  });

  assert.equal(result.projectionCacheManifest.protocolVersion, 1);
  assert.deepEqual(result.projectionCacheManifest.authority, {
    authorizationEpoch: 4,
    entitlementDigest: "digest",
  });
  assert.deepEqual(
    result.projectionCacheManifest.scopes.map((entry) => entry.scopeId),
    ["channel:a", "channel:b", "space:shared"],
  );
});

for (const scenario of [
  {
    title: "authority drift between Space roots voids the merged manifest",
    manifests: () => [manifest([scope("channel:a")]), manifest([scope("channel:b")], {
      authorizationEpoch: 5, entitlementDigest: "digest",
    })],
  },
  {
    title: "the same scope described two ways voids the merged manifest",
    manifests: () => [manifest([scope("space:shared")]), manifest([
      scope("space:shared", { changeHead: 11 }),
    ])],
  },
  {
    title: "a Space that contributed Channels without a manifest voids the merged manifest",
    manifests: () => [manifest([scope("channel:a")]), undefined],
  },
]) {
  test(scenario.title, async () => {
    const [first, second] = scenario.manifests();
    const result = await readSpaceFanoutChannelCatalog({
      noSpacesCatalog: NO_SPACES,
      ...catalogSource({
        "space-a": spaceCatalog("space-a", ["channel-a1"], first),
        "space-b": spaceCatalog("space-b", ["channel-b1"], second),
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.channels.length, 2);
    assert.equal("projectionCacheManifest" in result, false);
  });
}

test("a Space that contributed nothing leaves the merged manifest alone", async () => {
  const result = await readSpaceAFanout(spaceCatalog("space-b", []));

  assert.deepEqual(
    result.projectionCacheManifest.scopes.map((entry) => entry.scopeId),
    ["channel:a"],
  );
});

test("an unrecognised manifest protocol voids the merged manifest", async () => {
  const stale = manifest([scope("channel:b")]);
  stale.protocolVersion = 2;
  const result = await readSpaceAFanout(spaceCatalog("space-b", ["channel-b1"], stale));

  assert.equal("projectionCacheManifest" in result, false);
});

test("a catalog with no manifest anywhere carries none", async () => {
  const result = await readSpaceFanoutChannelCatalog({
    noSpacesCatalog: NO_SPACES,
    ...catalogSource({ "space-a": spaceCatalog("space-a", ["channel-a1"]) }),
  });

  assert.equal("projectionCacheManifest" in result, false);
});
