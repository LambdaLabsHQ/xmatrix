import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHumanMemberPresenceForChannel,
  humanMemberIdsForChannel,
  visibleHumanUserIds,
} from "../src/runtime-transport/human-live-presence.ts";

test("offline Humans remain directory membership instead of presence rows", () => {
  const presence = buildHumanMemberPresenceForChannel(
    ["user:offline"],
    [],
    "channel-1",
  );

  assert.deepEqual(presence, {});
});

test("live Human presence carries session identity and liveness", () => {
  const presence = buildHumanMemberPresenceForChannel(
    ["user:online"],
    [{
      userId: "online",
      name: "Online Person",
      email: "online@example.com",
      avatarUrl: "https://example.com/online.png",
      lastSeenAt: "2026-08-03T09:00:00.000Z",
      focusedChannelId: "channel-1",
    }],
    "channel-1",
  );

  assert.equal(presence["user:online"].status, "online");
  assert.equal(presence["user:online"].focused, true);
  assert.equal(presence["user:online"].label, "Online Person");
  assert.equal(presence["user:online"].email, "online@example.com");
  assert.equal(presence["user:online"].avatarUrl, "https://example.com/online.png");
});

test("live sessions cannot add Humans outside the visible membership projection", () => {
  const presence = buildHumanMemberPresenceForChannel(
    ["user:authorized"],
    [{
      userId: "not-authorized",
      name: "Not Authorized",
      lastSeenAt: "2026-08-03T09:00:00.000Z",
      focusedChannelId: "channel-1",
    }],
    "channel-1",
  );

  assert.deepEqual(presence, {});
});

test("visible Human recipients come only from canonical user identities", () => {
  assert.deepEqual(
    visibleHumanUserIds(["user:one", "agent:two", "user:one", "user:"]),
    ["one"],
  );
});

test("open Channels inherit Space members while closed Channels use their projection", () => {
  const inherited = humanMemberIdsForChannel(
    { mode: "open", spaceId: "space-1" },
    { "space-1": ["user:one", "user:two"] },
  );
  const restricted = humanMemberIdsForChannel(
    {
      mode: "closed",
      spaceId: "space-1",
      visibleHumanMemberIds: ["user:one"],
    },
    { "space-1": ["user:one", "user:two"] },
  );

  assert.deepEqual(inherited, ["user:one", "user:two"]);
  assert.deepEqual(restricted, ["user:one"]);
});
