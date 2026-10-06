import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  RelayPostgresChannelCoordinatorStore,
} from "../src/relay-postgres-channel-coordinator.ts";
import { sqliteStorage } from "./support/sqlite-storage.mjs";

function coordinator() {
  const database = new DatabaseSync(":memory:");
  const alarms = [];
  let alarm = null;
  const storage = {
    ...sqliteStorage(database),
    async getAlarm() { return alarm; },
    async setAlarm(value) {
      alarm = typeof value === "number" ? value : value.getTime();
      alarms.push(alarm);
    },
  };
  return {
    database,
    alarms,
    value: new RelayPostgresChannelCoordinatorStore({ storage }),
  };
}

test("PostgreSQL Channel coordinator stores only bounded sequence coordination", async () => {
  const { database, alarms, value } = coordinator();
  const first = await value.reserve({
    channelId: "channel-1", commandId: "command-1", observedPostgresHead: 5,
    now: "2026-08-29T00:00:00.000Z",
  });
  assert.deepEqual(first, {
    channelId: "channel-1", commandId: "command-1", sequence: 6, state: "reserved",
  });
  assert.deepEqual(await value.reserve({
    channelId: "channel-1", commandId: "command-1", observedPostgresHead: 99,
    now: "2026-08-29T00:01:00.000Z",
  }), first);
  const second = await value.reserve({
    channelId: "channel-1", commandId: "command-2", observedPostgresHead: 5,
    now: "2026-08-29T00:02:00.000Z",
  });
  assert.equal(second.sequence, 7);
  assert.deepEqual(value.confirm({
    channelId: "channel-1", commandId: "command-1", sequence: 6,
    factDigest: "a".repeat(64), now: "2026-08-29T00:03:00.000Z",
  }), {
    channelId: "channel-1", commandId: "command-1", sequence: 6, state: "committed",
  });
  assert.deepEqual(value.status({ channelId: "channel-1" }), {
    channelId: "channel-1", allocatedSequence: 7, confirmedSequence: 6, reservationCount: 2,
  });
  assert.deepEqual(alarms, [Date.parse("2026-09-28T00:00:00.000Z")]);
  assert.deepEqual(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all().map((row) => row.name),
    ["sequence_reservations", "sequence_state"],
  );
});

test("PostgreSQL Channel coordinator preserves the earliest reservation alarm", async () => {
  const { alarms, value } = coordinator();
  await value.reserve({
    channelId: "channel-1", commandId: "command-1", observedPostgresHead: 0,
    now: "2026-08-29T00:00:00.000Z",
  });
  await value.reserve({
    channelId: "channel-1", commandId: "command-2", observedPostgresHead: 1,
    now: "2026-08-30T00:00:00.000Z",
  });
  await value.reserve({
    channelId: "channel-1", commandId: "command-1", observedPostgresHead: 2,
    now: "2026-08-31T00:00:00.000Z",
  });
  assert.deepEqual(alarms, [Date.parse("2026-09-28T00:00:00.000Z")]);
});

test("PostgreSQL Channel coordinator cleans expired reservations in bounded batches", async () => {
  const { database, alarms, value } = coordinator();
  const insert = database.prepare(`INSERT INTO sequence_reservations
    (command_id, sequence, state, fact_digest, created_at, updated_at, expires_at)
    VALUES (?, ?, 'committed', ?, ?, ?, ?)`);
  for (let index = 0; index < 600; index += 1) {
    insert.run(
      `command-${index}`, index + 1, "a".repeat(64),
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    );
  }

  const startedAt = Date.now();
  const firstCleanup = await value.alarm();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sequence_reservations").get().count, 344);
  assert.ok(alarms.at(-1) >= startedAt + 1_000);
  assert.equal(firstCleanup.deleted, 256);
  assert.equal(firstCleanup.remaining, 257, "remaining telemetry is explicitly capped");
  assert.ok(firstCleanup.oldestAgeMs > 0);
  assert.ok(firstCleanup.durationMs >= 0);

  const secondCleanup = await value.alarm();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sequence_reservations").get().count, 88);
  assert.equal(secondCleanup.deleted, 256);
  assert.equal(secondCleanup.remaining, 88);

  const thirdCleanup = await value.alarm();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sequence_reservations").get().count, 0);
  assert.equal(thirdCleanup.deleted, 88);
  assert.equal(thirdCleanup.remaining, 0);
});

test("PostgreSQL Channel coordinator rejects identity and commitment drift", async () => {
  const { value } = coordinator();
  await value.reserve({
    channelId: "channel-1", commandId: "command-1", observedPostgresHead: 0,
  });
  await assert.rejects(value.reserve({
    channelId: "channel-2", commandId: "command-2", observedPostgresHead: 0,
  }), /identity mismatch/u);
  assert.throws(() => value.confirm({
    channelId: "channel-1", commandId: "command-1", sequence: 2,
    factDigest: "a".repeat(64),
  }), /reservation differs/u);
});
