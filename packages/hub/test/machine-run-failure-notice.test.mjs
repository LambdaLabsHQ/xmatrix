import assert from "node:assert/strict";
import test from "node:test";

import { machineRunFailureNoticeCommand, machineStopResultNoticeCommand } from "../src/machine-run-failure-notice.ts";

const base = { runId: "run-1", channelId: "channel-1", agentName: "grok", ownerUserId: "owner",
  ownerEmail: "owner@example.test", machineId: "machine:a", hostId: "cursor" };

test("Machine notices name the Machine as its owner named it, never its hostname", async () => {
  const start = await machineRunFailureNoticeCommand({ ...base, machineName: "Grok Bot Machine",
    detail: "wrapper_startup_failed", phase: "wrapper_startup_failed" });
  assert.match(start.body, /^Couldn't start @grok on Grok Bot Machine during wrapper_startup_failed\./u);
  const stop = await machineStopResultNoticeCommand({ ...base, machineName: "Grok Bot Machine", controlKey: "k", ok: true });
  assert.match(stop.body, /^Stopped @grok on Grok Bot Machine\./u);
  for (const body of [start.body, stop.body]) assert.doesNotMatch(body, /cursor/u);
});

test("a notice without the Machine name names no machine", async () => {
  const start = await machineRunFailureNoticeCommand({ ...base, detail: "boom" });
  assert.match(start.body, /^Couldn't start @grok\./u);
  const stop = await machineStopResultNoticeCommand({ ...base, controlKey: "k", ok: false });
  assert.match(stop.body, /^Couldn't stop @grok\./u);
  for (const body of [start.body, stop.body]) assert.doesNotMatch(body, /cursor/u);
});

test("repository preparation failures show actionable copy without publishing private paths", async () => {
  const input = { ...base, detail: "repo pool lease unavailable (base_ref_unresolved: could not resolve origin default branch after fetch) /private/SECRET_SENTINEL" };
  const notice = await machineRunFailureNoticeCommand(input);
  assert.match(notice.body, /no usable default branch/u);
  assert.match(notice.body, /initial commit/u);
  assert.equal(notice.residual.appMetadata.failureCode, "repository_base_unresolved");
  assert.doesNotMatch(JSON.stringify(notice), /SECRET_SENTINEL/u);
  assert.equal((await machineRunFailureNoticeCommand(input)).messageId, notice.messageId);
});

test("a repository the Space's GitHub connection cannot reach fails with its own reason, not a generic error", async () => {
  const notice = await machineRunFailureNoticeCommand({ ...base, machineName: "srv",
    detail: "this Space's GitHub connector could not authorize owner/missing (repository_access_unavailable: the Space's GitHub connection cannot access owner/missing (github_api_422)) /private/SECRET_SENTINEL" });
  assert.match(notice.body, /^Couldn't start @grok on srv\.\n\nThe Space's GitHub connection can't access owner\/missing\.\n\nCheck that the Space's GitHub app installation includes owner\/missing/u);
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
