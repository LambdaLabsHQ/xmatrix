import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAppRepository } from "@xmatrix/db";

import { appCommand, upsertAppConnection } from "../src/apps.ts";

function indexEnv(forgotten, reset = false) {
  return {
    RELAY_POSTGRES: { connectionString: "postgres://directory.invalid/xmatrix" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
    GITHUB_SUBSCRIPTION_INDEX: { idFromName: (name) => name, get: (id) => ({ forget: async () => {
      if (reset) throw new Error("index reset by a deploy");
      forgotten.push(id);
    } }) },
  };
}

test("a subscription write answers once each installation's index forgot, without naming them", async (t) => {
  t.mock.method(PostgresAppRepository.prototype, "command", async () => ({
    relation: { id: "relation-1" }, reused: false, githubInstallations: ["42", "43"] }));
  const forgotten = [];
  const answer = await appCommand(indexEnv(forgotten), "put-relation", { commandId: "subscribe-1" });
  assert.deepEqual(forgotten.sort(), ["42", "43"]);
  assert.deepEqual(answer, { relation: { id: "relation-1" }, reused: false });
});

test("a write whose index cannot be told fails retryably, so its replay tells it again", async (t) => {
  t.mock.method(PostgresAppRepository.prototype, "command", async () => ({
    relation: { id: "relation-1" }, reused: true, githubInstallations: ["42"] }));
  await assert.rejects(appCommand(indexEnv([], true), "put-relation", { commandId: "subscribe-1" }),
    (error) => error.code === "github_subscription_index_unavailable" && error.status === 503 && error.retryable === true);
});

test("a GitHub connection forgets the installations it was and is linked to; other writes forget nothing", async (t) => {
  t.mock.method(PostgresAppRepository.prototype, "upsert", async () => ({
    connection: { id: "space:github" }, reused: false, githubInstallations: ["41", "42"] }));
  const forgotten = [];
  const answer = await upsertAppConnection(indexEnv(forgotten), { commandId: "connect-1", spaceId: "space",
    actorUserId: "owner", providerId: "github", body: {} });
  assert.deepEqual(forgotten.sort(), ["41", "42"]);
  assert.deepEqual(answer, { connection: { id: "space:github" }, reused: false });

  t.mock.method(PostgresAppRepository.prototype, "command", async () => ({ ok: true, reused: false }));
  forgotten.length = 0;
  assert.deepEqual(await appCommand(indexEnv(forgotten), "remove-relation", { commandId: "remove-1" }),
    { ok: true, reused: false });
  assert.deepEqual(forgotten, []);
});
