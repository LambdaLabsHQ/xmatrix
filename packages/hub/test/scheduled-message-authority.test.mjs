import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchScheduledMessageOccurrence,
} from "../src/relay-authority-scheduled-message-delivery.ts";

test("legacy v2 message delivery remains a single owner-authored append and post-commit", async () => {
  let occurrenceStatus = "leased";
  const appended = [];
  const postCommits = [];
  const lifecycle = [];
  const port = {
    storage: {
      transactionSync(run) { return run(); },
      sql: {
        exec(query) {
          if (query.includes("SET status = 'prepared'")) occurrenceStatus = "prepared";
          if (query.includes("SET status = 'dispatched'")) occurrenceStatus = "dispatched";
        },
      },
    },
    first(query) {
      if (query.includes("FROM channels c")) return { mode: "open", archived_at: null, role: "member" };
      if (query.includes("status = 'prepared'")) return occurrenceStatus === "prepared" ? { present: 1 } : undefined;
      if (query.includes("status = 'dispatched'")) return occurrenceStatus === "dispatched" ? { present: 1 } : undefined;
      throw new Error(`unexpected delivery query: ${query}`);
    },
    async appendMessage(command) { appended.push(command); },
    schedulePostCommit(input) { postCommits.push(input); },
  };
  await dispatchScheduledMessageOccurrence(
    port,
    {
      id: "occurrence-v2",
      task_id: "task-v2",
      task_version: 1,
      status: "leased",
      scheduled_for: "2026-08-10T00:00:00.000Z",
      delivery_kind: "message",
      message_id: "message-v2",
      lease_owner: "worker-v2",
    },
    { id: "task-v2", owner_user_id: "legacy-owner", channel_id: "channel-v2" },
    { payloadVersion: 2, message: { body: "legacy status" } },
    {
      async requireEvaluationAuthority(channelId, userId) {
        lifecycle.push(["authorize", channelId, userId]);
      },
      async markPrepared() { lifecycle.push(["prepared"]); },
      async finishMessage() { lifecycle.push(["dispatched"]); },
    },
  );
  assert.equal(appended.length, 1);
  assert.equal(appended[0].body, "legacy status");
  assert.deepEqual(appended[0].principal, { kind: "user", id: "legacy-owner" });
  assert.equal(appended[0].authorityRootUserId, "legacy-owner");
  assert.equal(postCommits.length, 1);
  assert.equal(postCommits[0].senderKind, "user");
  assert.equal(postCommits[0].senderId, "legacy-owner");
  assert.deepEqual(lifecycle, [
    ["authorize", "channel-v2", "legacy-owner"], ["prepared"], ["dispatched"],
  ]);
});
