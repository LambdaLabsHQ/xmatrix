import assert from "node:assert/strict";
import { test } from "node:test";
import { readHarnessActionStatus } from "../dist/index.js";

const CONTROL_ID = "harness:00000000-0000-4000-8000-0000000000f1";

function statusFor(result) {
  const row = {
    command_id: CONTROL_ID,
    payload_json: { type: "machine_harness_action", requestId: CONTROL_ID, presetId: result.presetId, action: result.action },
    status: "completed",
    result_json: { result },
    created_at: "2026-11-21T19:00:00.000Z",
    completed_at: "2026-11-21T19:00:02.000Z",
    expired: false,
    abandoned: false,
  };
  const database = {
    async transaction(_options, run) {
      return run({ async query() { return [row]; } });
    },
  };
  return readHarnessActionStatus(database, { requestId: "req-1", ownerUserId: "owner", controlId: CONTROL_ID });
}

test("failed login_start does not surface arbitrary stdout tail lines as the error", async () => {
  const legacyHelp = await statusFor({
    presetId: "antigravity",
    action: "login_start",
    status: "failed",
    outputTail: "Commands available in print mode:\n/help  Show available commands\n/usage (quota)      View model quota usage\n",
  });
  assert.equal(legacyHelp.error, "The sign-in command exited without printing a sign-in link.");

  const cleanExit = await statusFor({
    presetId: "antigravity",
    action: "login_start",
    status: "failed",
    exitCode: 0,
    outputTail: "Already signed in.\n",
  });
  assert.equal(cleanExit.error, "The sign-in command exited without printing a sign-in link.");

  const timedOut = await statusFor({
    presetId: "codex",
    action: "login_start",
    status: "failed",
    outputTail: "Starting...\n[no sign-in link after 45 seconds]",
  });
  assert.equal(timedOut.error, "The sign-in command did not print a sign-in link within 45 seconds.");

  const realError = await statusFor({
    presetId: "antigravity",
    action: "login_start",
    status: "failed",
    exitCode: 2,
    outputTail: "flag provided but not defined: -login\n",
  });
  assert.equal(realError.error, "Exited with code 2: flag provided but not defined: -login");
});
