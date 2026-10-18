import assert from "node:assert/strict";

import { test } from "node:test";

import {
  agentTurnFailureAppendCommand,
  shouldPersistAgentTurnFailureNotice,
} from "../src/runtime-transport/agent-turn-failure-notice.ts";

test("only application/failed/turn_failed persists a channel notice", () => {
  assert.equal(
    shouldPersistAgentTurnFailureNotice({
      layer: "application",
      status: "failed",
      reason: "turn_failed",
    }),
    true,
  );
  assert.equal(
    shouldPersistAgentTurnFailureNotice({
      layer: "transport",
      status: "reconnecting",
      reason: "websocket_closed",
    }),
    false,
  );
});

test("turn-failure append is an agent-attributed system_fact, not a new task", () => {
  const command = agentTurnFailureAppendCommand({
    runId: "run-1",
    instanceId: "instance-1",
    executionKey: "exec-1",
    agentId: "agent-1",
    agentName: "opencode",
    ownerUserId: "user-1",
    channelId: "channel-1",
    detail: "Internal error: unknown certificate verification error",
    senderSnapshot: { model: "opencode-go/deepseek-v4.1-flash" },
  });
  assert.ok(command);
  assert.match(command.body, /opencode turn/);
  assert.match(command.body, /unknown certificate verification error/);
  assert.equal(command.payload.principal.kind, "agent");
  assert.equal(command.payload.principal.id, "agent-1");
  assert.equal(command.payload.residual.appMetadata.xmatrixProvenance, "system_fact");
  assert.equal(command.payload.residual.appMetadata.xmatrixTurnFailure, true);
  assert.equal(command.payload.agentRunProof.runId, "run-1");
});

test("background interruption is a scoped idempotent fact without claiming task failure", () => {
  const input = { runId: "run", instanceId: "instance", executionKey: "execution",
    agentId: "agent", agentName: "Claude", ownerUserId: "owner", channelId: "channel",
    senderSnapshot: {}, reason: "background_tasks_interrupted", noticeId: "provider-generation-1",
    detail: "The provider stream ended with 2 tasks pending. Their outcome is unknown." };
  assert.equal(shouldPersistAgentTurnFailureNotice({ layer: "application", status: "blocked", reason: input.reason }), true);
  assert.equal(shouldPersistAgentTurnFailureNotice({ layer: "transport", status: "blocked", reason: input.reason }), false);
  const first = agentTurnFailureAppendCommand(input);
  assert.ok(first);
  assert.match(first.body, /lost background-task tracking/);
  assert.doesNotMatch(first.body, /could not complete.*turn/);
  assert.equal(first.payload.residual.appMetadata.xmatrixBackgroundTaskInterruption, true);
  assert.equal(first.payload.residual.appMetadata.xmatrixTurnFailure, undefined);
  assert.equal(agentTurnFailureAppendCommand(input).commandId, first.commandId);
  assert.notEqual(agentTurnFailureAppendCommand({ ...input, noticeId: "provider-generation-2" }).commandId, first.commandId);
  assert.notEqual(agentTurnFailureAppendCommand({ ...input, channelId: "other-channel" }).commandId, first.commandId);
  assert.equal(agentTurnFailureAppendCommand({ ...input, noticeId: undefined }), null);
  assert.equal(agentTurnFailureAppendCommand({ ...input, noticeId: "bad key" }), null);
});

test("Hub words a background interruption from the host's count", () => {
  const input = { runId: "run", instanceId: "instance", executionKey: "execution",
    agentId: "agent", agentName: "Claude", ownerUserId: "owner", channelId: "channel",
    senderSnapshot: {}, reason: "background_tasks_interrupted", noticeId: "provider-generation-1" };
  assert.equal(agentTurnFailureAppendCommand({ ...input, pendingTasks: 2 }).body,
    "xMatrix lost background-task tracking for Claude. The provider stream ended with 2 tasks still pending. " +
    "Their outcome is unknown; verify external operations before continuing.");
  assert.match(agentTurnFailureAppendCommand({ ...input, pendingTasks: 1 }).body, /with 1 task still pending/u);
  // An older host sent the sentence itself.
  assert.match(agentTurnFailureAppendCommand({ ...input, detail: "legacy sentence" }).body, /tracking for Claude\. legacy sentence$/u);
});

test("a turn its program refused as signed out carries what to sign in; any other failure does not", () => {
  const signedOut = { harness: "claude", program: "Claude Code", machineId: "machine:mac", machineName: "mac-mini" };
  const failure = (reason) => agentTurnFailureAppendCommand({
    runId: "run-1", instanceId: "instance-1", executionKey: "exec-1", agentId: "agent-1", agentName: "claude",
    ownerUserId: "user-1", channelId: "channel-1", reason, signedOut, senderSnapshot: {},
    detail: "Failed to authenticate: OAuth session expired and could not be refreshed",
  }).payload.residual.appMetadata;
  const signedOutNotice = failure("harness_signed_out");
  assert.equal(signedOutNotice.kind, "xmatrix.harness-signed-out.v1");
  assert.deepEqual(signedOutNotice.signedOut, signedOut);
  assert.equal(signedOutNotice.xmatrixTurnFailure, true);
  assert.equal(failure("turn_failed").kind, undefined);
  assert.equal(failure("turn_failed").signedOut, undefined);
});
