import assert from "node:assert/strict";
import test from "node:test";
import { parseSupportDiagnosticEvent, parseSupportHandoffRequest, supportHandoffRequestProblem } from "../dist/index.js";

test("a handoff carries nothing until the person agrees, and only the parts they ticked", () => {
  assert.match(supportHandoffRequestProblem({ line: "stuck", parts: ["messages"] }), /agreement/u);
  assert.match(supportHandoffRequestProblem({ line: "stuck", parts: ["messages"], consent: "yes" }), /agreement/u);
  assert.deepEqual(parseSupportHandoffRequest({ line: "  stuck  ", parts: [], consent: true }),
    { line: "stuck", parts: [], consent: true }, "with nothing ticked only the line goes");
  for (const parts of [["everything"], ["messages", "messages"], "messages"]) {
    assert.equal(parseSupportHandoffRequest({ line: "stuck", parts, consent: true }), undefined);
  }
  assert.equal(parseSupportHandoffRequest({ line: "stuck", parts: ["logs"], consent: true }), undefined,
    "logs go only with the excerpt the person previewed");
  assert.equal(parseSupportHandoffRequest({ line: "stuck", parts: [], logExcerpt: "tail", consent: true }), undefined,
    "and an excerpt only with the logs part");
  assert.equal(parseSupportHandoffRequest({ line: "stuck", parts: [], consent: true, channelId: "other" }), undefined,
    "a field the request does not declare refuses it");
});

test("support diagnostics are allowlisted events, refused whole when a row carries anything else", () => {
  const launch = { kind: "launch", state: "failed", errorCode: "machine_offline", retryable: true, attempt: 2,
    createdAt: 1_790_000_000_000 };
  assert.deepEqual(parseSupportDiagnosticEvent(launch), launch);
  assert.equal(parseSupportDiagnosticEvent({ ...launch, errorMessage: "/home/person/secret failed" }), undefined);
  assert.equal(parseSupportDiagnosticEvent({ ...launch, errorCode: "Free text from stderr" }), undefined);
  assert.equal(parseSupportDiagnosticEvent({ kind: "run", status: "running", createdAt: 1, runId: "r#1" }), undefined);
});
