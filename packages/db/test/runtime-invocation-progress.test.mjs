import assert from "node:assert/strict";
import test from "node:test";
import { invocationProgress, readInvocationProgress } from "../dist/runtime-invocation-progress.js";
const at = "2026-09-12T15:00:00Z";
test("machine progress preserves bounded task evidence without granting execution or delivery authority", () => {
  const taskExecution = { execution: { executionId: "execution:1", revision: 1, sourceCount: 1,
    sources: [{ channelId: "channel", messageId: "message", sequence: 1, entityVersion: 1, bodyHash: "a".repeat(64) }],
    state: "accepted", startedAtMillis: 100, updatedAtMillis: 100 } };
  const projected = invocationProgress({ statusPhase: "turn_running", taskExecution,
    prompt: "PRIVATE", taskSecret: "PRIVATE" }, at);
  assert.deepEqual(projected.taskExecution, taskExecution);
  assert.deepEqual(readInvocationProgress(projected).taskExecution, taskExecution);
  assert.equal(JSON.stringify(projected).includes("PRIVATE"), false);
  assert.equal(projected.delivered, undefined);
  assert.equal(projected.runStatus, undefined);
});
test("wrapper versions survive projection without accepting arbitrary diagnostic text", () => {
  for (const wrapperVersion of ["0.16.224", "0.16.224-rc.1+build.2"]) {
    const value = invocationProgress({ statusPhase: "turn_running", wrapperVersion }, at);
    assert.equal(value.wrapperVersion, wrapperVersion);
    assert.equal(readInvocationProgress(value).wrapperVersion, wrapperVersion);
  }
  for (const wrapperVersion of ["/private/path", "Bearer secret", "1.2.3\nsecret", "1.2.3-" + "a".repeat(80)]) {
    assert.equal(invocationProgress({ statusPhase: "turn_running", wrapperVersion }, at).wrapperVersion, undefined);
    assert.equal(readInvocationProgress({ phase: "turn_running", observedAt: at, wrapperVersion }).wrapperVersion, undefined);
  }
});
test("progress exposes a closed phase and no stdout, path, credential, or arbitrary error", () => {
  const value = invocationProgress({ statusPhase: "relay_register_retrying", runStatusDetail: "secret-token",
    stderrLogPath: "/private/log", executionKey: "secret", wrapperReadyAtMillis: Date.parse(at) }, at);
  assert.deepEqual(value, { phase: "relay_register_retrying", observedAt: at,
    wrapperReadyAt: new Date(at).toISOString(), errorCode: "relay.registration_retrying" });
  assert.equal(invocationProgress({ statusPhase: "Bearer secret" }, at), undefined);
  assert.equal(invocationProgress({ wrapperReadyAtMillis: Date.parse(at) + 900_000 }, at), undefined);
});
test("local completion is only a phase, never a delivery receipt or terminal Run command", () => {
  assert.deepEqual(invocationProgress({ statusPhase: "turn_completed", completed: true, delivered: true }, at),
    { phase: "turn_completed", observedAt: at });
});

test("legacy metadata cannot inject private diagnostic copy into the public view", () => {
  assert.deepEqual(readInvocationProgress({ phase: "private-token", errorCode: "password=secret", observedAt: at }), {});
  assert.deepEqual(readInvocationProgress({ phase: "turn_completed", observedAt: at,
    diagnosticId: "Bearer secret", errorCode: "secret" }), { phase: "turn_completed", observedAt: at });
});

test("registration retry counters and scheduled retry survive safe projection", () => {
  const next = Date.parse(at) + 30000;
  const value = invocationProgress({ statusPhase: "relay_register_retrying",
    connectionRetry: { attempt: 7, nextAttemptAtMillis: next, token: "private" } }, at);
  assert.deepEqual(value.connectionRetry, { attempt: 7, nextAttemptAt: new Date(next).toISOString() });
  assert.deepEqual(readInvocationProgress(value).connectionRetry, value.connectionRetry);
  assert.equal(invocationProgress({ statusPhase: "relay_register_retrying",
    connectionRetry: { attempt: -1 } }, at).connectionRetry, undefined);
});

test("startup checkpoints are bounded, closed, deduplicated and survive later phases", () => {
  const timestamp = Date.parse(at);
  const value = invocationProgress({ statusPhase: "codex_app_ready", startupSteps: [
    { phase: "relay_registered", atMillis: timestamp - 3000 },
    { phase: "codex_app_ready", atMillis: timestamp - 1000 },
    { phase: "runtime_ready", atMillis: timestamp },
    { phase: "secret-token", atMillis: timestamp },
    { phase: "turn_completed", atMillis: timestamp },
    { phase: "cwd_ready", atMillis: timestamp + 900000 },
  ] }, at);
  assert.equal(value.phase, "runtime_ready");
  assert.deepEqual(value.startupSteps, [
    { phase: "relay_registered", at: new Date(timestamp - 3000).toISOString() },
    { phase: "runtime_ready", at: new Date(timestamp - 1000).toISOString() },
  ]);
  assert.deepEqual(readInvocationProgress(value).startupSteps, value.startupSteps);
  const bounded = invocationProgress({ statusPhase: "turn_running",
    startupSteps: Array.from({ length: 100 }, () => ({ phase: "relay_registered", atMillis: timestamp })) }, at);
  assert.equal(bounded.startupSteps.length, 1);
});


test("typed failures retain their own classification and origin without parsing private text", () => {
  const failure = { code: "agent_run_binding_mismatch", stage: "relay.authenticate", originStage: "authority.request",
    diagnosticId: "diag_11111111-1111-4111-8111-111111111111", retryable: false };
  const report = invocationProgress({ statusPhase: "wrapper_startup_failed", operationFailure: { ...failure, token: "PRIVATE" },
    runStatusDetail: "a different private failure" }, at);
  assert.deepEqual(report.operationFailure, failure);
  assert.equal(report.errorCode, failure.code);
  assert.equal(report.diagnosticId, failure.diagnosticId);
  assert.deepEqual(readInvocationProgress(report).operationFailure, failure);
  assert.equal(JSON.stringify(report).includes("PRIVATE"), false);
  assert.equal(invocationProgress({ statusPhase: "runtime_ready" }, at).operationFailure, undefined);
  assert.equal(invocationProgress({ statusPhase: "wrapper_startup_failed", operationFailure: { code: "bad" } }, at).errorCode, "runtime.startup_failed");
});


test("channel join retry evidence remains distinct from registration and retains its kind", () => {
  const progress = invocationProgress({ statusPhase: "channel_join_retrying", connectionRetry: { attempt: 2, kind: "channel_join" } }, at);
  assert.equal(progress.phase, "channel_join_retrying");
  assert.equal(progress.errorCode, "relay.channel_join_retrying");
  assert.equal(readInvocationProgress(progress).connectionRetry.kind, "channel_join");
});
