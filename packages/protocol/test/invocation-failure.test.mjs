import assert from "node:assert/strict";
import test from "node:test";
import { isLaunchHintRejection, launchRefusal, parameterFailureCodeFromDecisionRecord, preparationFailureSummary,
  preparationRejectionMessage, parseDecisionAnswerFailure, parseHarnessTooOld, parseHarnessSignedOut,
  harnessSignedOutNoticeOf, HARNESS_SIGNED_OUT_NOTICE_KIND,
  REGISTRATION_PREPARATION_REJECTION_CODES } from "../dist/index.js";

test("every registered summon rejection has a public, bounded explanation", () => {
  for (const code of REGISTRATION_PREPARATION_REJECTION_CODES) {
    assert.match(preparationRejectionMessage(code), /[Nn]o launch was allocated\.$/);
  }
  assert.match(preparationFailureSummary("registration_directory_unavailable"), /requested directory is not authorized/);
  assert.equal(preparationFailureSummary("registration_repository_unavailable"), undefined);
  assert.equal(preparationRejectionMessage("registration_environment_private_provider_payload"), undefined);
  // An offline machine is told apart from a missing registration or Workspace.
  assert.match(preparationFailureSummary("registration_daemon_offline"), /machine is offline.*when it reconnects\.$/);
  assert.doesNotMatch(preparationRejectionMessage("registration_daemon_offline"), /workspace|registered environment/i);
});

test("only readings and machine-naming prompts are launch hints; failures are not", () => {
  for (const code of ["summon_intent_reference", "summon_intent_explanation", "summon_intent_example",
    "registration_machine_not_auto_assigned", "registration_machine_ambiguous"]) {
    assert.equal(isLaunchHintRejection(code), true, code);
  }
  for (const code of ["registration_quota_exhausted", "registration_daemon_offline", "registration_launch_rejected",
    "registration_machine_unavailable", "unknown"]) {
    assert.equal(isLaunchHintRejection(code), false, code);
  }
  // Every machine hint has a public explanation the card can show.
  assert.match(preparationFailureSummary("registration_machine_not_auto_assigned"), /machine:<name>/);
  assert.match(preparationFailureSummary("registration_machine_ambiguous"), /More than one person's machine/);
});

test("a named offline machine is not reported as a missing registration", () => {
  const code = (...args) => launchRefusal(...args).code;
  const offline = [{ machineId: "laptop-id", machineName: "Laptop", reason: "daemon_offline" }];
  assert.equal(code("registration_machine_unavailable", "Laptop", offline), "registration_daemon_offline");
  assert.equal(code("registration_not_found", "machine:laptop-id", [{ machineId: "machine:laptop-id", reason: "daemon_offline" }]), "registration_daemon_offline");
  assert.equal(code("registration_machine_unavailable", "Other", offline), "registration_machine_unavailable");
  assert.equal(code("registration_not_found", undefined, offline), "registration_not_found");
  assert.equal(code("registration_harness_unavailable", "Laptop", offline), "registration_harness_unavailable");
});

test("a launch only a too-old harness could take names the program, its version and the update", () => {
  const tooOld = { program: "Cursor CLI", version: "2025.09.12-4852336", minimumVersion: "2026.01.01",
    machineName: "Laptop", update: "cursor-agent update" };
  const outdated = [{ machineId: "laptop-id", machineName: "Laptop", reason: "harness_outdated", tooOld }];
  assert.deepEqual(launchRefusal("registration_not_found", undefined, outdated), { code: "registration_harness_outdated", tooOld });
  assert.equal(launchRefusal("registration_machine_unavailable", "Laptop", outdated).code, "registration_harness_outdated");
  // Another machine being too old says nothing about the one named.
  assert.deepEqual(launchRefusal("registration_machine_unavailable", "Other", outdated), { code: "registration_machine_unavailable" });

  assert.equal(preparationRejectionMessage("registration_harness_outdated", tooOld),
    "Cursor CLI on Laptop is 2025.09.12, too old for xMatrix, which needs 2026.01.01 or later. " +
    'Run "cursor-agent update" there, then try again. No launch was allocated.');
  const { machineName: _machine, update: _update, ...unnamed } = tooOld;
  assert.equal(preparationFailureSummary("registration_harness_outdated", unnamed),
    "Cursor CLI is 2025.09.12, too old for xMatrix, which needs 2026.01.01 or later. Update it on that computer, then try again.");
  // A stored detail is read back only whole and bounded.
  assert.equal(parseHarnessTooOld({ ...tooOld, program: "" }), undefined);
  assert.equal(parseHarnessTooOld({ ...tooOld, update: "cursor-agent update\nrm -rf /" }), undefined);
  assert.equal(parseHarnessTooOld({ ...tooOld, machineName: "x".repeat(201) }), undefined);
  assert.deepEqual(parseHarnessTooOld(tooOld), tooOld);
  // Another code's detail is not read as one.
  assert.equal(preparationRejectionMessage("registration_daemon_offline", tooOld), preparationRejectionMessage("registration_daemon_offline"));
});

test("a launch only a signed-out harness could take names the program and machine to sign in", () => {
  const signedOut = { harness: "codex", program: "Codex", machineId: "mac-id", machineName: "mac-mini" };
  const blocked = [{ machineId: "mac-id", machineName: "mac-mini", reason: "harness_signed_out", signedOut }];
  assert.deepEqual(launchRefusal("registration_not_found", undefined, blocked),
    { code: "registration_harness_signed_out", signedOut });
  assert.equal(launchRefusal("registration_machine_unavailable", "mac-mini", blocked).code, "registration_harness_signed_out");
  // Another machine being signed out says nothing about the one named.
  assert.deepEqual(launchRefusal("registration_machine_unavailable", "Other", blocked), { code: "registration_machine_unavailable" });
  // Too old is the cause first: signing in would not make it answer.
  const tooOld = { program: "Codex", version: "0.1.0", minimumVersion: "0.2.0" };
  assert.equal(launchRefusal("registration_not_found", undefined,
    [...blocked, { machineId: "pc", reason: "harness_outdated", tooOld }]).code, "registration_harness_outdated");

  assert.equal(preparationRejectionMessage("registration_harness_signed_out", signedOut),
    "Codex on mac-mini is not signed in, so it can't take work. Sign it in from here, then the message goes to it. No launch was allocated.");
  assert.equal(parseHarnessSignedOut({ ...signedOut, harness: "Codex X" }), undefined);
  assert.equal(parseHarnessSignedOut({ ...signedOut, machineName: "a\nb" }), undefined);
  assert.deepEqual(parseHarnessSignedOut(signedOut), signedOut);

  const notice = { kind: HARNESS_SIGNED_OUT_NOTICE_KIND, signedOut, sourceMention: "@auto", sourceMessageId: "m-1" };
  assert.deepEqual(harnessSignedOutNoticeOf(notice), { signedOut, sourceMention: "@auto", sourceMessageId: "m-1" });
  assert.equal(harnessSignedOutNoticeOf({ ...notice, sourceMention: "auto" }), null);
  assert.equal(harnessSignedOutNoticeOf({ ...notice, kind: "other" }), null);
});

test("historical failure evidence resolves to the same public cause as new rejections", () => {
  for (const [record, expected] of [
    [{ status: "failed", reason: "timeout" }, "routing_parameter_jev_aborted"],
    [{ status: "failed", reason: "invalid_answer" }, "routing_parameter_invalid_answer"],
    [{ status: "failed", reason: "provider_error", code: "jev_rate_limited" }, "routing_parameter_jev_rate_limited"],
    [{ status: "failed", reason: "timeout", code: "jev_rate_limited" }, "routing_parameter_jev_aborted"],
    [{ status: "failed", reason: "provider_error", code: "jev_secret_private" }, "routing_parameter_jev_evaluation_failed"],
  ]) {
    assert.equal(parameterFailureCodeFromDecisionRecord(record), expected);
    assert.ok(preparationFailureSummary(expected));
    assert.match(preparationRejectionMessage(expected), /No launch was allocated\.$/);
  }
  assert.equal(parameterFailureCodeFromDecisionRecord({ status: "succeeded", code: "jev_rate_limited" }), undefined);
  assert.equal(preparationRejectionMessage("private_provider_error"), undefined);
});

test("answer failures name the actual request key without a fixed parameter list", () => {
  const detail = { questionKey: "browserMode", issue: "choice_not_offered" };
  assert.deepEqual(parseDecisionAnswerFailure(detail), detail);
  assert.equal(preparationFailureSummary("routing_parameter_invalid_answer", detail),
    `xMatrix's "browserMode" answer selected an option that was not offered.`);
  assert.equal(parseDecisionAnswerFailure({ questionKey: "private\ntext", issue: "choice_not_offered" }), undefined);
  assert.equal(parseDecisionAnswerFailure({ questionKey: "browserMode", issue: "private error" }), undefined);
});


test("draft readings bind the exact UTF-16 range and reject stale or ambiguous input", async () => {
  const { parseDraftSummonIntents } = await import("../dist/index.js");
  const body = "🌍 @codex asks @codex";
  const first = { start: 3, end: 9, mention: "@codex", choice: "summon" };
  const second = { start: 15, end: 21, mention: "@codex", choice: "reference" };
  assert.deepEqual(parseDraftSummonIntents([first, second], body), [first, second]);
  assert.equal(parseDraftSummonIntents(undefined, body), undefined);
  for (const value of [null, {}, [first, first], [{ ...first, start: 2 }], [{ ...first, end: 10 }],
    [{ ...first, choice: "invalid" }], [{ ...first, extra: true }], [{ ...first, start: -1 }],
    [{ ...first, start: 3.5 }], Array(17).fill(first)]) assert.throws(() => parseDraftSummonIntents(value, body));
  assert.throws(() => parseDraftSummonIntents([first], "changed body"));
});
