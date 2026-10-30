import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthorityDatabase } from "@xmatrix/db";
import { sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { authorityPort, recordingCommands } from "./support/machine-daemon-port.mjs";
import { captureErrorReports, exceptionEvents } from "./support/error-reports.mjs";

// HUB-BC: completion's best-effort catch discarded the exception and the
// client's failure evidence. Successful About delivery cannot catch that gap.
test("a failed text answer keeps its database evidence and original stack while acknowledging completion", async (t) => {
  const envelopes = captureErrorReports(t);
  t.mock.method(console, "warn", () => {});
  const error = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  error.stack = "error: canceling statement due to lock timeout\n    at applyAbout (index.js:123:4)";
  const database = createAuthorityDatabase({ connectionString: "postgres://unused.invalid/test", shardId: "shard-0",
    clientFactory: () => ({
      async connect() {}, async end() {},
      async query(input) {
        if (typeof input === "object" && input.text === "SELECT fail") throw error;
        return { rows: [], rowCount: 0 };
      },
    }),
  });
  const calls = [];
  const requestId = "channel-about:private-channel:3:5:summary:123e4567-e89b-12d3-a456-426614174000";
  const port = authorityPort({ commands: recordingCommands(calls), textTaskAnswered: () =>
    database.transaction({ requestId, operation: "channel.channel_configure" }, tx => tx.query({
      name: "channel_mutation_root_lock_v2", text: "SELECT fail", maxRows: 1,
    })),
  });
  const reply = await port.execute({ principal: { ownerUserId: "private-owner", machineId: "private-machine", hostId: "host" },
    connectionEpoch: 1, capabilities: ["machine_text_task_v1"] }, { type: "machine_text_task_result", requestId,
    result: { status: "completed", presetId: "codex", text: "private task answer" } });
  assert.deepEqual(reply, { type: "machine_command_completion_acked", requestId, controlId: requestId });
  assert.equal(calls.length, 1);
  await sendErrorReports();
  const events = exceptionEvents(envelopes);
  assert.equal(events.length, 1, "one original exception, without a synthetic console duplicate");
  const event = events[0];
  assert.equal(event.tags.operation, "machine.text-task.apply");
  const attempt = JSON.parse(event.extra.database_failure_attempts)[0];
  assert.equal(attempt.queryName, "channel_mutation_root_lock_v2");
  assert.equal(attempt.phase, "sql");
  assert.equal(attempt.code, "55P03");
  assert.equal(event.exception.values[0].stacktrace.frames[0].function, "applyAbout");
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "app:///index.js");
  assert.doesNotMatch(JSON.stringify(event), /private-channel|private-owner|private-machine|private task answer/u);
});
