import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresSharedMemoryRepository,
  SharedMemoryControlError,
} from "../dist/shared-memory-control.js";
import { recordingDatabase as database } from "./recording-database.fixture.mjs";

function memoryDatabase(usage = { rows_count: 0, workspace_bytes: 0, global_bytes: 0 }) {
  return database(query => query.name === "shared_memory_usage_v1" ? [usage] : []);
}

test("Shared Memory put reclaims expired rows and ignores them in admission quota", async () => {
  const db = memoryDatabase();
  const result = await new PostgresSharedMemoryRepository(db).put({
    commandId: "put-1", ownerUserId: "u", key: "fresh", value: "ok",
  });
  assert.deepEqual(result, { ok: true, key: "fresh" });
  const reclaim = db.calls.find((call) => call.name === "shared_memory_expire_reclaim_v1");
  assert.equal(Boolean(reclaim), true);
  assert.match(reclaim.text, /expires_at <= clock_timestamp\(\)/u);
  assert.equal(reclaim.values[0], 256);
  const usage = db.calls.find((call) => call.name === "shared_memory_usage_v1");
  assert.match(usage.text, /expires_at IS NULL OR expires_at > clock_timestamp\(\)/u);
});

test("Shared Memory put no longer treats a full expired workspace as exhausted", async () => {
  const db = memoryDatabase();
  await new PostgresSharedMemoryRepository(db).put({
    commandId: "put-expired-full", ownerUserId: "u", key: "fresh", value: 1,
  });
  const usage = db.calls.find((call) => call.name === "shared_memory_usage_v1");
  assert.equal(usage.text.includes("expires_at"), true);
});

test("Shared Memory still rejects a live workspace that is actually full", async () => {
  const db = memoryDatabase({ rows_count: 10_000, workspace_bytes: 64 * 1024 * 1024, global_bytes: 64 * 1024 * 1024 });
  await assert.rejects(
    new PostgresSharedMemoryRepository(db).put({
      commandId: "put-full", ownerUserId: "u", key: "fresh", value: 1,
    }),
    (error) => error instanceof SharedMemoryControlError &&
      error.code === "shared_memory_workspace_backpressure",
  );
});
