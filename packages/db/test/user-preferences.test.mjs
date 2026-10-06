import { recordingDatabase } from "./recording-database.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseContractError,
  PostgresUserPreferenceRepository,
} from "../dist/index.js";

const context = {
  requestId: "request-preference-1",
  operation: "user-preference.update",
  placement: { spaceId: "space-1", shardId: "shard-0", placementEpoch: 1 },
};

function scriptedDatabase(script, cacheMode = "disabled") {
  return recordingDatabase(query => {
    const next = script.shift();
    assert.ok(next, `unexpected query ${query.name}`);
    assert.equal(query.name, next.name);
    return next.rows ?? [];
  }, { cacheMode, recordContext: false, checkContext: received => assert.equal(received, context) });
}

function preferenceWriteChecks() {
  return [
    { name: "user_preference_membership_v1", rows: [{ role: "owner" }] },
    { name: "user_preference_idempotency_lock_v1", rows: [{ locked: null }] },
    { name: "user_preference_expired_idempotency_delete_v1" },
    { name: "user_preference_idempotency_read_v1" },
    { name: "user_preference_aggregate_lock_v1", rows: [{ locked: null }] },
  ];
}

test("user preference repository requires correctness Hyperdrive and matching placement", async () => {
  assert.throws(
    () => new PostgresUserPreferenceRepository(scriptedDatabase([], "cached")),
    DatabaseContractError,
  );
  const repository = new PostgresUserPreferenceRepository(scriptedDatabase([]));
  await assert.rejects(
    repository.readLocale({ ...context, placement: { ...context.placement, spaceId: "space-2" } }, "space-1", "user-1"),
    /matching Space placement/u,
  );
});

test("missing PostgreSQL preferences preserve product defaults", async () => {
  const database = scriptedDatabase([
    { name: "user_preference_membership_v1", rows: [{ role: "owner" }] },
    { name: "user_space_locale_preference_read_v1" },
    { name: "user_preference_membership_v1", rows: [{ role: "owner" }] },
    { name: "user_space_channel_view_preference_read_v2" },
  ]);
  const repository = new PostgresUserPreferenceRepository(database);
  assert.deepEqual(await repository.readLocale(context, "space-1", "user-1"), {
    spaceId: "space-1", displayLocale: null, editingLocale: null, version: 0,
  });
  assert.deepEqual(await repository.readChannelView(context, "space-1", "user-1"), {
    spaceId: "space-1", followUpReviewSchedule: "off",
    pinnedChannelIds: [], version: 0,
  });
  assert.equal(database.calls.every((query) => query.maxRows === 1), true);
});

test("locale preference update is aggregate-serialized, CAS-written, and idempotent", async () => {
  const database = scriptedDatabase([
    ...preferenceWriteChecks(),
    { name: "user_space_locale_preference_for_update_v1" },
    { name: "user_space_locale_preference_upsert_v1", rows: [{ version: "1" }] },
    { name: "user_preference_idempotency_insert_v1", rows: [{ idempotency_key: "command-1" }] },
  ]);
  const repository = new PostgresUserPreferenceRepository(database);
  assert.deepEqual(await repository.updateLocale(context, {
    commandId: "command-1", spaceId: "space-1", userId: "user-1",
    expectedVersion: 0, displayLocale: "zh-CN", at: "2026-08-29T01:02:03.000Z",
  }), { version: 1, reused: false });
  assert.equal(database.calls[1].values[0], JSON.stringify(["idempotency", "space-1", "command-1"]));
  assert.equal(database.calls[4].values[0], JSON.stringify(["locale", "space-1", "user-1"]));
  assert.equal(database.calls.some((query) => query.values?.some((value) =>
    typeof value === "string" && value.includes("\0"))), false);
  assert.match(database.calls[6].text, /ON CONFLICT \(space_id, user_id\).*WHERE data\.user_space_locale_preferences\.version = \$7/su);
  assert.match(database.calls[7].text, /data\.idempotency_keys/u);
  assert.equal(database.calls[7].values[4], JSON.stringify({ version: 1 }));
});

test("preference writes reject values that the Durable Object authority rejects", async () => {
  const repository = new PostgresUserPreferenceRepository(scriptedDatabase([]));
  await assert.rejects(repository.updateLocale(context, {
    commandId: "invalid-locale", spaceId: "space-1", userId: "user-1",
    expectedVersion: 0, displayLocale: "not_a_locale", at: "2026-08-29T01:02:03.000Z",
  }), /locale preference is invalid/u);
  await assert.rejects(repository.updateChannelView(context, {
    commandId: "duplicate-pin", spaceId: "space-1", userId: "user-1",
    expectedVersion: 0, pinnedChannelIds: ["channel-1", "channel-1"],
    at: "2026-08-29T01:02:03.000Z",
  }), /pinnedChannelIds is invalid/u);
});

test("an identical idempotency replay returns the committed version without another write", async () => {
  const input = {
    commandId: "command-replay", spaceId: "space-1", userId: "user-1",
    expectedVersion: 3, editingLocale: "en-US", at: "2026-08-29T01:02:03.000Z",
  };
  const canonical = JSON.stringify({
    at: input.at,
    commandId: input.commandId,
    commandKind: "user_space_locale_preference_update",
    editingLocale: input.editingLocale,
    expectedVersion: input.expectedVersion,
    spaceId: input.spaceId,
    userId: input.userId,
  });
  const digest = [...new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(canonical),
  ))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  const replayDatabase = scriptedDatabase([
    ...preferenceWriteChecks().slice(0, 3),
    {
      name: "user_preference_idempotency_read_v1",
      rows: [{
        command_kind: "user_space_locale_preference_update",
        request_digest: digest,
        result_json: { version: "4" },
      }],
    },
  ]);
  const replayRepository = new PostgresUserPreferenceRepository(replayDatabase);
  assert.deepEqual(await replayRepository.updateLocale(context, input), { version: 4, reused: true });
  assert.equal(replayDatabase.calls.length, 4);
});

test("channel-view update retains omitted fields and fails closed on a lost CAS", async () => {
  const database = scriptedDatabase([
    ...preferenceWriteChecks(),
    {
      name: "user_space_channel_view_preference_for_update_v2",
      rows: [{
        follow_up_review_schedule: "daily",
        pinned_channel_ids_json: ["channel-1"],
        version: 2,
        created_at: "2026-08-28T01:02:03.000Z",
      }],
    },
    {
      name: "user_preference_visible_channels_v3",
      rows: [{
        channel_id: "channel-2", mode: "open", metadata_json: null,
        role: "owner", grant_version: null,
      }],
    },
    { name: "user_space_channel_view_preference_upsert_v2" },
  ]);
  const repository = new PostgresUserPreferenceRepository(database);
  await assert.rejects(repository.updateChannelView(context, {
    commandId: "command-view", spaceId: "space-1", userId: "user-1",
    expectedVersion: 2, pinnedChannelIds: ["channel-2"], at: "2026-08-29T01:02:03.000Z",
  }), /channel view preference version changed/u);
  assert.equal(database.calls[7].values[2], "daily");
  assert.equal(database.calls[7].values[3], JSON.stringify(["channel-2"]));
});
