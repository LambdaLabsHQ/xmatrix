import assert from "node:assert/strict";
import test from "node:test";
import * as boundary from "./support/channel-response-human-presence-dependencies.mjs";
import { state } from "./support/channel-response-human-presence-dependencies.mjs";

// Keep the real Runtime presence overlay. Only the RelayRuntime binding and the
// Channel read are injected.
import {
  beginLiveHumanPresenceRead,
  channelReadsWithLiveHumanPresence,
  channelWithLiveHumanPresence,
  committedChannelWithLiveHumanPresence,
} from "../src/channel-response-human-presence.ts";

const REQUEST_URL = "https://hub.test/api/channels";
const AGENT_PRESENCE = { "agent:writer": { kind: "agent", label: "writer", instances: [] } };
const OPEN_CHANNEL = {
  id: "channel-1", spaceId: "space-1", name: "General", mode: "open", version: 1,
  memberPresence: AGENT_PRESENCE,
  createdBy: "owner", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};
const CLOSED_CHANNEL = {
  ...OPEN_CHANNEL, id: "channel-2", name: "Private", mode: "closed",
  visibleHumanMemberIds: ["user:online", "user:offline"],
};
const LIVE_SESSION = {
  userId: "online", name: "Online Person", email: "online@example.com",
  lastSeenAt: "2026-09-17T00:00:00.000Z", focusedChannelId: "channel-1",
};
const HINT = { "space-1": ["user:online", "user:offline"] };

function reset() {
  state.reads.length = 0;
  state.requests.length = 0;
  state.runtimeSessions = [LIVE_SESSION];
  state.runtimeFails = false;
  state.readFails = false;
}

test("a get-channel read of an open Channel comes back with its live Humans", async () => {
  reset();
  const sessions = beginLiveHumanPresenceRead({}, REQUEST_URL, boundary);
  const channel = await channelWithLiveHumanPresence(
    { channel: OPEN_CHANNEL, openChannelHumanMemberIdsBySpace: HINT }, sessions,
  );
  assert.equal(channel.memberPresence["user:online"].status, "online");
  assert.equal(channel.memberPresence["user:online"].focused, true);
  // Durable Agent presence survives; an offline member stays directory
  // membership rather than becoming a presence row.
  assert.equal(channel.memberPresence["agent:writer"].kind, "agent");
  assert.equal(channel.memberPresence["user:offline"], undefined);
  // The member hint is a Hub-internal input, never part of the response.
  assert.equal(channel.openChannelHumanMemberIdsBySpace, undefined);
  assert.deepEqual(state.requests.map((request) => request.kind), ["runtime"]);
});

test("a closed Channel names its own Humans, so no hint is needed", async () => {
  reset();
  state.runtimeSessions = [{ ...LIVE_SESSION, focusedChannelId: null }];
  const channel = await channelWithLiveHumanPresence(
    { channel: CLOSED_CHANNEL }, beginLiveHumanPresenceRead({}, REQUEST_URL, boundary),
  );
  assert.equal(channel.memberPresence["user:online"].status, "online");
  assert.equal(channel.memberPresence["user:online"].focused, false);
});

test("a Runtime that cannot be reached degrades to the Agent-only projection", async () => {
  reset();
  state.runtimeFails = true;
  const channel = await channelWithLiveHumanPresence(
    { channel: OPEN_CHANNEL, openChannelHumanMemberIdsBySpace: HINT },
    beginLiveHumanPresenceRead({}, REQUEST_URL, boundary),
  );
  assert.deepEqual(channel.memberPresence, AGENT_PRESENCE);
});

test("a tree of reads shares one hint and one Runtime read", async () => {
  reset();
  const child = { ...OPEN_CHANNEL, id: "channel-1-child", parentChannelId: "channel-1" };
  const channels = await channelReadsWithLiveHumanPresence([
    { channel: OPEN_CHANNEL, openChannelHumanMemberIdsBySpace: HINT },
    { channel: child, openChannelHumanMemberIdsBySpace: HINT },
  ], beginLiveHumanPresenceRead({}, REQUEST_URL, boundary));
  assert.equal(channels.length, 2);
  assert.equal(channels[0].memberPresence["user:online"].focused, true);
  assert.equal(channels[1].memberPresence["user:online"].status, "online");
  assert.equal(channels[1].memberPresence["user:online"].focused, false);
  assert.deepEqual(state.requests.map((request) => request.kind), ["runtime"]);
});

test("a committed Channel is re-read as the actor so it carries live Humans", async () => {
  reset();
  state.reads.push({ channel: OPEN_CHANNEL, openChannelHumanMemberIdsBySpace: HINT });
  const channel = await committedChannelForCreator({ ...OPEN_CHANNEL, memberPresence: {} });
  assert.equal(channel.memberPresence["user:online"].status, "online");
  assert.equal(channel.memberPresence["agent:writer"].kind, "agent");
  const read = state.requests.find((request) => request.kind === "get-channel");
  assert.deepEqual(read.input, { channelId: "channel-1", principal: { kind: "user", id: "creator" } });
});

test("a committed Channel whose re-read fails still goes back, Agent-only", async () => {
  reset();
  state.readFails = true;
  const committed = { ...OPEN_CHANNEL, memberPresence: AGENT_PRESENCE };
  const channel = await committedChannelForCreator(committed);
  assert.deepEqual(channel, committed);
});

function committedChannelForCreator(committed) {
  return committedChannelWithLiveHumanPresence({ boundary, env: {},
    channelId: "channel-1", principal: { kind: "user", id: "creator" }, committed,
    sessions: beginLiveHumanPresenceRead({}, REQUEST_URL, boundary) });
}
