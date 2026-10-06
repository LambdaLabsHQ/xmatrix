import assert from "node:assert/strict";
import test from "node:test";
import { PostgresSpaceControlRepository } from "@xmatrix/db";

import { configureChannel, createChannel } from "../src/spaces.ts";
import { publishHumanChannelCatalogChangedToSessions } from "../src/connections/human/registry.ts";
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
    return "private";
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
  }, { database: { cacheMode: "disabled" }, wakeAffectedChannels: async (_database, spaceId) => { woken.push(spaceId); } });
  assert.deepEqual(result.channel, channel);
  assert.deepEqual(calls, ["route", "commit", "route", "read"]);
  assert.deepEqual(woken, ["private"], "a placement change tells the Channels whose executions it can withdraw");
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

test("a cross-Space move publishes separate ACL-bounded watermarks", async (t) => {
  const woken = [];
  const publications = [];
  let routeCalls = 0;
  t.mock.method(PostgresSpaceControlRepository.prototype, "resolveChannelSpaceId", async () => {
    routeCalls += 1;
    return routeCalls === 1 ? "source" : "target";
  });
  t.mock.method(PostgresSpaceControlRepository.prototype, "mutateChannel", async () => ({
    entityId: "channel-1", entityVersion: 2,
  }));
  t.mock.method(PostgresSpaceControlRepository.prototype, "getChannel", async () => ({
    channel: { id: "channel-1", spaceId: "target", name: "Moved" },
  }));
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
    wakeAffectedChannels: async (_database, spaceId) => { woken.push(spaceId); },
    publishCatalogChanges: async (changes) => publications.push(...changes),
  });
  assert.deepEqual(publications.map(({ spaceId, recipientUserIds }) => ({ spaceId, recipientUserIds })), [
    { spaceId: "source", recipientUserIds: ["source-user"] },
    { spaceId: "target", recipientUserIds: ["target-user"] },
  ]);
  assert.deepEqual(woken, ["source"]);
});

test("Space reads wait out the same Hyperdrive checkout as message reads", () => {
  assert.equal(POSTGRES_AUTHORITY_TIMEOUTS.connectTimeoutMs, POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS);
  assert.equal(POSTGRES_AUTHORITY_TIMEOUTS.connectTimeoutMs, 8_000);
});
