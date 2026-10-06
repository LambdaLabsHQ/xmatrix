import assert from "node:assert/strict";
import test from "node:test";

import { readChannelViewPreference, updateLocalePreference } from "../src/user-preference-postgres-authority.ts";

const env = {
  RELAY_POSTGRES: { connectionString: "postgres://authority.invalid/xmatrix" },
  RELAY_POSTGRES_SHARD_ID: "shard-0",
};

function database(respond) {
  const session = {
    opens: 0,
    closes: 0,
    cacheMode: "disabled",
    async close() { session.closes += 1; },
    openSession() { session.opens += 1; return session; },
    async transaction(context, callback) {
      return callback({
        async query(query) {
          return respond(query, context);
        },
      });
    },
  };
  return session;
}

test("user preference reads fail closed without the PostgreSQL binding", async () => {
  await assert.rejects(readChannelViewPreference({}, { spaceId: "space-1", userId: "user-1" }),
    /is unavailable/u);
});

test("PostgreSQL channel-view reads enforce membership and current Channel visibility", async () => {
  const db = database((query) => {
    if (query.name === "space_placement_resolve_v1") return [{
      space_id: "space-1", shard_id: "shard-0", placement_epoch: 1,
      state: "active", target_shard_id: null, plan_class: "shared",
    }];
    if (query.name === "user_preference_membership_v1") return [{ role: "owner" }];
    if (query.name === "user_space_channel_view_preference_read_v2") return [{
      follow_up_review_schedule: "daily",
      pinned_channel_ids_json: ["channel-open", "channel-direct"],
      version: 3,
    }];
    if (query.name === "user_preference_visible_channels_v3") {
      return [{ channel_id: "channel-open" }];
    }
    return [];
  });
  assert.deepEqual(await readChannelViewPreference(env, { spaceId: "space-1", userId: "user-1" }, { database: db }), {
    spaceId: "space-1",
    followUpReviewSchedule: "daily",
    pinnedChannelIds: ["channel-open"],
    version: 3,
  });
  assert.equal(db.opens, 1);
  assert.equal(db.closes, 1);
});

test("PostgreSQL preference updates fail closed when membership is absent", async () => {
  const db = database((query) => query.name === "space_placement_resolve_v1" ? [{
    space_id: "space-1", shard_id: "shard-0", placement_epoch: 1,
    state: "active", target_shard_id: null, plan_class: "shared",
  }] : []);
  await assert.rejects(updateLocalePreference(env, { spaceId: "space-1", userId: "user-1", update: {
    commandId: "preference-1", at: "2026-08-31T00:00:00.000Z", expectedVersion: 0, displayLocale: "zh-CN",
  } }, { database: db }), { message: "Space membership required", code: "user_preference_forbidden", status: 403 });
  assert.equal(db.opens, 1);
  assert.equal(db.closes, 1);
});
