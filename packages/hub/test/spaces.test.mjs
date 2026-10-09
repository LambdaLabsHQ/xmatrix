import assert from "node:assert/strict";
import test from "node:test";
import { PostgresSpaceControlRepository } from "@xmatrix/db";

import { configureChannel, createChannel } from "../src/spaces.ts";
import { publishHumanChannelCatalogChangedToSessions, publishHumanWorkspaceResourceChangedToSessions } from "../src/connections/human/registry.ts";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "../src/postgres-authority-http.ts";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "../src/postgres-message-database-policy.ts";

const postgresEnv = {
  RELAY_POSTGRES: { connectionString: "postgres://authority.invalid/xmatrix" },
  RELAY_POSTGRES_SHARD_ID: "shard-0",
};

test("catalog revision fanout reaches only exact Space members", () => {
  const sockets = [{ id: "one" }, { id: "two" }, { id: "other" }];
  const sessions = sockets.map((socket) => [socket, { userId: socket.id }]);
  const delivered = [];
  const result = publishHumanChannelCatalogChangedToSessions({
    message: { type: "space_channel_catalog_changed", spaceId: "space", revision: 8 },
    recipientUserIds: ["one", "two"],
  }, sessions, (socket, message) => {
    delivered.push([socket.id, message]);
    return true;
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(delivered.map(([id]) => id), ["one", "two"]);
});

test("workspace resource fanout reaches only the named principals", () => {
  const sockets = [{ id: "owner" }, { id: "member" }];
  const sessions = sockets.map((socket) => [socket, { userId: socket.id }]);
  const delivered = [];
  const result = publishHumanWorkspaceResourceChangedToSessions({
    message: {
      type: "workspace_resource_changed", spaceId: "space", resource: "cross_space_reads",
      channelId: "channel", revision: 3,
    },
    recipientUserIds: ["owner"],
  }, sessions, (socket, message) => {
    delivered.push([socket.id, message.resource, message.channelId]);
    return true;
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(delivered, [["owner", "cross_space_reads", "channel"]]);
  const rejected = publishHumanWorkspaceResourceChangedToSessions({
    message: { type: "workspace_resource_changed", spaceId: "space", resource: "pages", revision: 1 },
    recipientUserIds: ["owner"],
  }, sessions, () => true);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "invalid_message");
});

test("catalog revision fanout rejects malformed metadata", () => {
  const result = publishHumanChannelCatalogChangedToSessions({
    message: { type: "space_channel_catalog_changed", spaceId: "space", revision: 0 },
    recipientUserIds: ["one"],
  }, [], () => true);
  assert.deepEqual(result, {
    accepted: false, reason: "invalid_message", recipientUsers: 0, matchedSessions: 0, delivered: 0, failed: 0,
  });
});

test("configure answers the committed Channel through its current route and actor ACL", async (t) => {
  const woken = [];
  const calls = [];
  const channel = { id: "channel-1", spaceId: "private", name: "Moved" };
  t.mock.method(PostgresSpaceControlRepository.prototype, "mutateChannel", async (input) => {
    calls.push("commit");
    assert.equal(input.spaceId, "private");
    return { entityId: input.channelId, entityVersion: 2 };
  });
  t.mock.method(PostgresSpaceControlRepository.prototype, "resolveChannelSpaceId", async (input) => {
    calls.push("route");
    assert.equal(input.channelId, "channel-1");
    // Where the Channel was before the commit, then where it is now.
    return calls.includes("commit") ? "private" : "shared";
  });
  t.mock.method(PostgresSpaceControlRepository.prototype, "getChannel", async (input) => {
    calls.push("read");
    assert.equal(input.spaceId, "private");
    assert.deepEqual(input.principal, { kind: "user", id: "owner" });
    return { channel };
  });
  const result = await configureChannel(postgresEnv, {
    commandId: "move-1", actorUserId: "owner", channelId: "channel-1", spaceId: "private",
    at: "2026-09-12T00:00:00.000Z",
  }, { database: { cacheMode: "disabled" }, recheckChannels: async (channelIds) => { woken.push(...channelIds); } });
  assert.deepEqual(result.channel, channel);
  assert.deepEqual(calls, ["route", "commit", "route", "read"]);
  assert.deepEqual(woken, ["channel-1"], "a placement change tells the Channel whose executions it can withdraw");
});

test("a created Channel publishes the authoritative Space watermark", async (t) => {
  const publications = [];
  t.mock.method(PostgresSpaceControlRepository.prototype, "createChannel", async () => ({
    channel: { id: "channel-2", spaceId: "space-1", name: "Second" },
  }));
  t.mock.method(PostgresSpaceControlRepository.prototype, "channelCatalogChangeAudiences", async (input) => {
    assert.deepEqual(input.spaceIds, ["space-1"]);
    return [{ spaceId: "space-1", revision: 12, recipientUserIds: ["one", "two"] }];
  });
  await createChannel(postgresEnv, {
    commandId: "create-2", channelId: "channel-2", spaceId: "space-1", name: "Second", mode: "open",
    principal: { kind: "user", id: "one" },
  }, { database: { cacheMode: "disabled" }, publishCatalogChanges: async (changes) => publications.push(...changes) });
  assert.deepEqual(publications, [{ spaceId: "space-1", revision: 12, recipientUserIds: ["one", "two"] }]);
});

/** The repository's answers for `channel-1`: its Space before the commit and after it, and its read. */
function configuredChannel(t, before, after, channel) {
  let committed = false;
  t.mock.method(PostgresSpaceControlRepository.prototype, "resolveChannelSpaceId", async () => committed ? after : before);
  t.mock.method(PostgresSpaceControlRepository.prototype, "mutateChannel", async () => {
    committed = true;
    return { entityId: "channel-1", entityVersion: 2 };
  });
  t.mock.method(PostgresSpaceControlRepository.prototype, "getChannel", async () => ({ channel }));
}

test("a cross-Space move publishes separate ACL-bounded watermarks", async (t) => {
  const woken = [];
  const publications = [];
  configuredChannel(t, "source", "target", { id: "channel-1", spaceId: "target", name: "Moved" });
  t.mock.method(PostgresSpaceControlRepository.prototype, "channelCatalogChangeAudiences", async (input) => {
    assert.deepEqual(input.spaceIds, ["source", "target"]);
    return [
      { spaceId: "source", revision: 4, recipientUserIds: ["source-user"] },
      { spaceId: "target", revision: 9, recipientUserIds: ["target-user"] },
    ];
  });
  await configureChannel(postgresEnv, {
    commandId: "move-1", actorUserId: "owner", channelId: "channel-1", spaceId: "target",
    at: "2026-09-12T00:00:00.000Z",
  }, {
    database: { cacheMode: "disabled" },
    recheckChannels: async (channelIds) => { woken.push(...channelIds); },
    publishCatalogChanges: async (changes) => publications.push(...changes),
  });
  assert.deepEqual(publications.map(({ spaceId, recipientUserIds }) => ({ spaceId, recipientUserIds })), [
    { spaceId: "source", recipientUserIds: ["source-user"] },
    { spaceId: "target", recipientUserIds: ["target-user"] },
  ]);
  assert.deepEqual(woken, ["channel-1"]);
});

// 2026-10-09: every summary an About session wrote rechecked each Channel of its Space.
test("a rename, topic or summary rechecks nothing; a mode change rechecks only that Channel", async (t) => {
  const woken = [];
  configuredChannel(t, "space-1", "space-1", { id: "channel-1", spaceId: "space-1", name: "Renamed" });
  const dependencies = {
    database: { cacheMode: "disabled" },
    publishCatalogChanges: async () => undefined,
    wakeAffectedChannels: async () => { throw new Error("a configure never rechecks the whole Space"); },
    recheckChannels: async (channelIds) => { woken.push(channelIds); },
  };
  const base = { commandId: "configure-1", actorUserId: "owner", channelId: "channel-1", at: "2026-10-09T00:00:00.000Z" };
  await configureChannel(postgresEnv, { ...base, name: "Renamed", topic: "t", summary: "s" }, dependencies);
  assert.deepEqual(woken, []);
  await configureChannel(postgresEnv, { ...base, mode: "closed" }, dependencies);
  assert.deepEqual(woken, [["channel-1"]]);
});

test("Space reads wait out the same Hyperdrive checkout as message reads", () => {
  assert.equal(POSTGRES_AUTHORITY_TIMEOUTS.connectTimeoutMs, POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS);
  assert.equal(POSTGRES_AUTHORITY_TIMEOUTS.connectTimeoutMs, 8_000);
});
