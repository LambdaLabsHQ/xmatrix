import assert from "node:assert/strict";
import test from "node:test";

import { machineRunFailureNoticeCommand, machineStopCauseText, machineStopResultNoticeCommand, repositoryBaselineNoticeCommand,
  signedOutStartNoticeCommand, startupFallbackNoticeCommand } from "../src/machine-run-failure-notice.ts";
import { answerStartupFailure } from "../src/machine-run-lifecycle-report.ts";

const base = { runId: "run-1", channelId: "channel-1", agentName: "grok", ownerUserId: "owner",
  ownerEmail: "owner@example.test", machineId: "machine:a", hostId: "cursor" };

test("continuity notices have immutable commands across remote changes and later reborns", async () => {
  const baseline = { baseRef: "origin/main", baseOid: "a".repeat(40), noticeKey: "b".repeat(64), relationship: "diverged",
    remote: { baseRef: "origin/trunk", baseOid: "c".repeat(40), confirmedAt: "2026-10-08T10:00:00Z" } };
  const first = await repositoryBaselineNoticeCommand({ ...base, baseline });
  const later = await repositoryBaselineNoticeCommand({ ...base, runId: "run-2", agentName: "codex", baseline: {
    ...baseline, remote: { ...baseline.remote, baseOid: "d".repeat(40) } } });
  assert.deepEqual(later, first, "stable command and message deduplicate without payload conflicts");
  assert.equal(first.residual.appMetadata.xmatrixProvenance, "system_fact");
  assert.match(first.body, /checkout and uncommitted work have been preserved/u);
  await assert.rejects(repositoryBaselineNoticeCommand({ ...base, baseline: { ...baseline, relationship: "unknown" } }));
});

test("Machine notices name the Machine as its owner named it, never its hostname", async () => {
  const start = await machineRunFailureNoticeCommand({ ...base, machineName: "Grok Bot Machine",
    detail: "wrapper_startup_failed", phase: "wrapper_startup_failed" });
  assert.match(start.body, /^Couldn't start @grok on Grok Bot Machine during wrapper_startup_failed\./u);
  const stop = await machineStopResultNoticeCommand({ ...base, machineName: "Grok Bot Machine", controlKey: "k", ok: true });
  assert.match(stop.body, /^Stopped @grok on Grok Bot Machine\./u);
  for (const body of [start.body, stop.body]) assert.doesNotMatch(body, /cursor/u);
});

test("a failed start carries its Agent's harness, which gives the notice the Agent's face", async () => {
  const start = await machineRunFailureNoticeCommand({ ...base, harness: "grok", detail: "boom" });
  assert.equal(start.residual.appMetadata.harness, "grok");
  const unnamed = await machineRunFailureNoticeCommand({ ...base, detail: "boom" });
  assert.equal("harness" in unnamed.residual.appMetadata, false);
});

test("a notice without the Machine name names no machine", async () => {
  const start = await machineRunFailureNoticeCommand({ ...base, detail: "boom" });
  assert.match(start.body, /^Couldn't start @grok\./u);
  const stop = await machineStopResultNoticeCommand({ ...base, controlKey: "k", ok: false });
  assert.match(stop.body, /^Couldn't stop @grok\./u);
  for (const body of [start.body, stop.body]) assert.doesNotMatch(body, /cursor/u);
});

test("a failed stop shows the daemon's error after boundary redaction", async () => {
  const stop = await machineStopResultNoticeCommand({ ...base, controlKey: "k", ok: false,
    detail: "process tree still alive after SIGKILL: /home/alice/.config/xmatrix/run.pid token=SECRET_SENTINEL" });
  assert.match(stop.body, /process tree still alive after SIGKILL: \[local path\] token=\[REDACTED\]/u);
  assert.doesNotMatch(stop.body, /alice|SECRET_SENTINEL|daemon logs/u);
  assert.equal(stop.residual.appMetadata.stopFailureCode, "process_tree_still_alive");
});

test("repository preparation failures preserve the cause without publishing private paths", async () => {
  const input = { ...base, detail: "repo pool lease unavailable (base_ref_unresolved: could not resolve origin default branch after fetch) /private/SECRET_SENTINEL" };
  const notice = await machineRunFailureNoticeCommand(input);
  assert.match(notice.body, /could not resolve origin default branch after fetch/u);
  assert.doesNotMatch(notice.body, /initial commit/u);
  assert.equal(notice.residual.appMetadata.failureCode, "repository_base_unresolved");
  assert.doesNotMatch(JSON.stringify(notice), /SECRET_SENTINEL/u);
  assert.equal((await machineRunFailureNoticeCommand(input)).messageId, notice.messageId);
});

test("a repository the Space's GitHub connection cannot reach fails with its own reason, not a generic error", async () => {
  const notice = await machineRunFailureNoticeCommand({ ...base, machineName: "srv",
    detail: "this Space's GitHub connector could not authorize owner/missing (repository_access_unavailable: the Space's GitHub connection cannot access owner/missing (github_api_422)) /private/SECRET_SENTINEL" });
  assert.match(notice.body, /github_api_422/u);
  assert.match(notice.body, /could not authorize owner\/missing/u);
  assert.equal(notice.residual.appMetadata.failureCode, "repository_access_unavailable");
  assert.doesNotMatch(JSON.stringify(notice), /SECRET_SENTINEL|gh auth status/u);
});

test("cleanup after failed startup still presents the startup failure", async () => {
  const notice = await machineStopResultNoticeCommand({ ...base, controlKey: "cleanup", ok: true, startupFailed: true });
  assert.match(notice.body, /^Startup failed for @grok\./u);
  assert.match(notice.body, /Cleanup confirmed no process remains/u);
  assert.doesNotMatch(notice.body, /^Stopped/u);
  assert.equal(notice.residual.appMetadata.startupFailed, true);
});

test("fetch stderr survives in both the Channel body and invocation metadata", async () => {
  const detail = "repo pool lease unavailable (fetch_required_failed: required origin fetch failed (\n ! [rejected] main -> origin/main (non-fast-forward)))";
  const notice = await machineRunFailureNoticeCommand({ ...base, detail });
  assert.equal(notice.body, `Couldn't start @grok.\n\n${detail}`);
  assert.equal(notice.residual.appMetadata.failureDetail, detail);
  assert.equal(notice.residual.appMetadata.failureCode, "repository_fetch_failed");
});

test("the Agent that takes over a failed start is named once per failed Run", async () => {
  const notice = await startupFallbackNoticeCommand({ ...base, agentName: "claude" });
  assert.equal(notice.body, "@claude is taking this message instead.");
  assert.equal(notice.residual.appMetadata.source, "startup_fallback");
  assert.equal(notice.messageKind, "xmatrix.system.runtime-failure");
  assert.deepEqual(await startupFallbackNoticeCommand({ ...base, agentName: "claude" }), notice);
  assert.notEqual((await startupFallbackNoticeCommand({ ...base, runId: "run-2", agentName: "claude" })).messageId, notice.messageId);
  assert.notEqual(notice.messageId, (await machineRunFailureNoticeCommand({ ...base, detail: "boom" })).messageId);
});

test("a start its program refused as signed out is its sign-in, with the summon to send again", async () => {
  const signedOut = { harness: "codex", program: "Codex", machineId: "machine:a", machineName: "Build Box" };
  const summoned = await signedOutStartNoticeCommand({ ...base, agentName: "codex", machineName: "Build Box", signedOut,
    sourceMessageId: "message-1", sourceMention: "@codex fix it" });
  assert.equal(summoned.body, "Couldn't start @codex on Build Box. Codex on Build Box is not signed in, so it can't take work. " +
    "Sign it in from here, then the message goes to it.");
  assert.deepEqual(summoned.residual.appMetadata, { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true, runId: "run-1",
    kind: "xmatrix.harness-signed-out.v1", signedOut, sourceMessageId: "message-1", sourceMention: "@codex fix it" });
  // Without a summon to send again it offers the sign-in alone; one notice per failed Run.
  const alone = await signedOutStartNoticeCommand({ ...base, agentName: "codex", signedOut, sourceMessageId: "message-1" });
  assert.match(alone.body, /Sign it in from here\.$/u);
  assert.equal(alone.residual.appMetadata.sourceMention, undefined);
  assert.equal(alone.residual.appMetadata.sourceMessageId, undefined);
  assert.equal(alone.messageId, summoned.messageId);
  assert.notEqual(summoned.messageId, (await machineRunFailureNoticeCommand({ ...base, detail: "boom" })).messageId);
});

test("a failed start says so on its summon; a signed-out one gives its sign-in, and its summon unless another Agent took it", async () => {
  const context = { runId: "run-1", channelId: "channel-1", ownerUserId: "owner", agentName: "codex", machineId: "machine:a",
    harness: "codex", machineName: "Build Box", sourceMessageId: "message-1", sourceMention: "@auto fix it" };
  const answered = async (extra, handed) => {
    const calls = [];
    await answerStartupFailure({}, { ...context, ...extra }, { detail: "Not logged in", phase: "runtime_starting" },
      "owner@example.test", {
        failed: async (_env, input) => { calls.push(["failed", input.detail]); },
        startupFallback: async (_env, input) => { calls.push(["fallback", input.runId]); return handed; },
        handedOn: async (_env, input) => { calls.push(["handed", input.agentName]); },
        signedOutStart: async (_env, input) => { calls.push(["sign-in", input.signedOut.program, input.sourceMention]); },
      });
    return calls;
  };
  assert.deepEqual(await answered({}, undefined), [["failed", "Not logged in"], ["fallback", "run-1"]]);
  assert.deepEqual(await answered({ signedOut: true }, undefined), [["fallback", "run-1"], ["sign-in", "Codex", "@auto fix it"]]);
  assert.deepEqual(await answered({ signedOut: true }, { agentName: "grok" }),
    [["fallback", "run-1"], ["handed", "grok"], ["sign-in", "Codex", undefined]]);
});

test("a stop nothing in the Channel asked for says why and who caused it", async () => {
  const stop = await machineStopResultNoticeCommand({ ...base, machineName: "Build Box", controlKey: "k", ok: true,
    cause: { code: "registration_disabled", actorName: "Daniel" } });
  assert.equal(stop.body, "Stopped @grok on Build Box. Daniel turned this Agent off in this Space. " +
    "The Machine confirmed the process tree is terminated.");
  assert.equal(stop.residual.appMetadata.stopCause, "registration_disabled");
  const failed = await machineStopResultNoticeCommand({ ...base, controlKey: "k", ok: false,
    cause: { code: "instance_deleted", ownerName: "Ada" } });
  assert.match(failed.body, /^Couldn't stop @grok\. Ada deleted this Instance\.\n/u);
  assert.equal(machineStopCauseText({ code: "registration_membership" }),
    "This Agent's owner is no longer a member of this Space, so it can't run here.");
  assert.equal(machineStopCauseText({ code: "something_new" }), undefined, "an unknown cause is not guessed");
});


test("a process found gone before it was ready is a failed start that says what the daemon saw", async () => {
  const { machineRunStartupFailureDetail } = await import("../src/machine-run-failure.ts");
  // Production 11-03: Antigravity's wrapper vanished after relay_registered;
  // the next daemon found it gone and had only the agent's name to report.
  const gone = machineRunStartupFailureDetail("machine_run_exited", { statusPhase: "relay_registered",
    status: "process no longer exists", runStatusDetail: "antigravity", completed: false });
  assert.equal(gone?.phase, "relay_registered");
  assert.match(gone.detail, /gone before it was ready/u);
  assert.doesNotMatch(gone.detail, /^antigravity$/u);
  for (const statusPhase of ["channel_joined", "cwd_preparing", "codex_app_starting", "runtime_starting"]) {
    assert.ok(machineRunStartupFailureDetail("machine_run_exited", { statusPhase, status: "exit code: 1", exitCode: 1 }), statusPhase);
  }
  for (const statusPhase of ["runtime_ready", "turn_running", "turn_completed"]) {
    assert.equal(machineRunStartupFailureDetail("machine_run_exited", { statusPhase, status: "exit code: 1" }), undefined, statusPhase);
  }
});
