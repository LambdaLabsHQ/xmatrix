import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { registerChannelCatalogPagingRoutes } from "../src/channel-catalog-paging-routes.ts";
import { createChannelCatalogReader } from "../src/channel-catalog-read.ts";

// A Space of many Channels in which two hold the reader's attention, one of
// them a Channel this catalog does not list.
const channels = Array.from({ length: 450 }, (_, index) => ({
  id: `channel-${index}`, spaceId: "space-1", name: `Channel ${index}`, mode: "open", version: 1,
}));
const summary = (channelId) => ({ channelId, unreadAttentionCount: 1,
  lastAttentionAt: "2026-11-23T00:00:00.000Z", updatedAt: "2026-11-23T00:00:00.000Z" });

function boundary() {
  const calls = { list: [], attention: [] };
  const reader = createChannelCatalogReader({
    listChannels: async (_env, input) => {
      calls.list.push(input);
      const offset = Number(input.cursor ?? 0);
      const page = channels.slice(offset, offset + input.limit);
      return { catalogRevision: 7, channels: page, openChannelHumanMemberIdsBySpace: {},
        cursor: offset + input.limit < channels.length ? String(offset + input.limit) : null };
    },
    listSpaces: async () => [{ id: "space-1" }, { id: "space-quiet" }, { id: "space-down" }],
    readSpaceAttentionProjection: async (_env, spaceId, subjectId) => {
      calls.attention.push({ spaceId, subjectId });
      if (spaceId === "space-down") throw new Error("unavailable");
      return spaceId === "space-1" ? ["channel-3", "channel-401", "not-listed"].map((channelId) =>
        ({ channelId, subjectId, summary: summary(channelId) })) : [];
    },
  });
  return { calls, reader };
}

// The whole-catalog read used to resolve every Channel's full row, 200 at a
// time, only to keep the few attention summaries: megabytes from the database
// for each read of a large Space.
test("a complete catalog asks once for a Space's attention, however many Channels it lists", async () => {
  const { calls, reader } = boundary();
  const read = await reader.readChannelCatalogForPrincipal({}, { kind: "user", id: "viewer" }, "space-1");
  assert.equal(read.ok, true);
  assert.equal(read.channels.length, 450);
  assert.equal(calls.list.length, 3);
  assert.deepEqual(calls.attention, [{ spaceId: "space-1", subjectId: "user:viewer" }]);
  assert.deepEqual(read.attentionSnapshot, { protocolVersion: 1, spaces: [{ spaceId: "space-1", complete: true,
    summaries: [summary("channel-3"), summary("channel-401")] }] });
  assert.deepEqual(read.channels[3].attention, summary("channel-3"));
  assert.equal(read.channels[4].attention, undefined);
});

test("a catalog read that names words asks the list for them, in the one Space or in each", async () => {
  const one = boundary();
  await one.reader.readChannelCatalogForPrincipal({}, { kind: "agent", id: "run:1", spaceId: "space-1" },
    undefined, undefined, undefined, ["egress", "billing"]);
  assert.deepEqual(one.calls.list.map((input) => [input.spaceId, input.find]),
    [["space-1", ["egress", "billing"]], ["space-1", ["egress", "billing"]], ["space-1", ["egress", "billing"]]]);
  const plain = boundary();
  await plain.reader.readChannelCatalogForPrincipal({}, { kind: "user", id: "viewer" }, "space-1", undefined, undefined, []);
  assert.equal(plain.calls.list[0].find, undefined);
});

test("what waits on a person is answered without reading any catalog", async () => {
  const { calls, reader } = boundary();
  const app = new Hono();
  registerChannelCatalogPagingRoutes(app, {
    requireAuth: async () => ({ id: "viewer" }),
    requestErrorResponse: (c, error) => c.json({ error: error.message }, error.status || 500),
    readAttentionSnapshotForUser: reader.readAttentionSnapshotForUser,
  });
  const response = await app.request("https://hub.test/api/channels/attention", {}, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { attentionSnapshot: { protocolVersion: 1, spaces: [
    { spaceId: "space-1", complete: true,
      summaries: [summary("channel-3"), summary("channel-401"), summary("not-listed")] },
    { spaceId: "space-quiet", complete: true, summaries: [] },
    // A Space that cannot answer says so; it never reads as nothing waiting.
    { spaceId: "space-down", complete: false, summaries: [] },
  ] } });
  assert.equal(calls.list.length, 0);
  assert.equal(calls.attention.length, 3);
});

test("an Agent Run cannot read a person's attention", async () => {
  const { reader } = boundary();
  const app = new Hono();
  registerChannelCatalogPagingRoutes(app, {
    requireAuth: async () => ({ id: "owner", agentRun: { runId: "run" } }),
    requestErrorResponse: (c, error) => c.json({ error: error.message }, error.status || 500),
    readAttentionSnapshotForUser: reader.readAttentionSnapshotForUser,
  });
  assert.equal((await app.request("https://hub.test/api/channels/attention", {}, {})).status, 403);
});
