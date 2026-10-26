require("./typescript-require.cjs").installTypeScriptRequire();
const assert = require("node:assert/strict");
const test = require("node:test");
const { agentFailureEvidence } = require("@xmatrix/protocol");
const { turnFailureEvidenceOf, turnFailuresContinuedByLaterSpeech, turnProblem } = require("./turn-failure.ts");

/* The details failed turns reported in the last two weeks, read the way the Hub records them. */
const problem = (detail) => turnProblem(agentFailureEvidence(detail));

test("a failed turn's cause comes from the evidence the Hub recorded, not its prose", () => {
  assert.equal(problem("exceeded retry limit, last status: 429 Too Many Requests | codexErrorInfo=responseTooManyFailedAttempts | httpStatusCode=429"), "rate_limited");
  assert.equal(problem("unexpected status 403 Forbidden: Unknown error, url: https://chatgpt.com/backend-api/codex/responses"), "provider_refused");
  assert.equal(problem("The Claude process exited before responding. exit code: 1"), "process_exited");
  assert.equal(problem("request timed out after 120s"), "unreachable");
  assert.equal(problem("error_during_execution: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"), "no_status");
  assert.equal(problem("API Error: 500"), "unknown");
  // A number in prose is not an HTTP status, so the turn stays in the no-status bucket.
  assert.equal(problem("wrote 429 lines before stopping"), "no_status");
});

test("a later message from the same agent settles its turn-failure notice", () => {
  const evidence = { xmatrixTurnFailure: true, xmatrixFailureEvidence: { version: 1, ...agentFailureEvidence("error_during_execution") } };
  const failure = { id: "fail", author: "claude:1", senderKind: "agent", senderInstanceId: "inst-1", provenance: "system_fact", metadata: evidence };
  const speech = { id: "next", author: "claude:1", senderKind: "agent", senderInstanceId: "inst-1", body: "continued" };
  assert.deepEqual([...turnFailuresContinuedByLaterSpeech([failure, speech])], ["fail"]);
  assert.equal(turnFailuresContinuedByLaterSpeech([failure, { ...speech, senderKind: "user", author: "Daniel" }]).size, 0);
  assert.equal(turnFailuresContinuedByLaterSpeech([failure, { ...speech, provenance: "system_fact" }]).size, 0);
  assert.equal(turnFailuresContinuedByLaterSpeech([failure, { ...speech, senderInstanceId: "inst-2", author: "claude:1" }]).size, 0);
  assert.deepEqual([...turnFailuresContinuedByLaterSpeech([
    { ...failure, senderInstanceId: undefined },
    { ...speech, senderInstanceId: undefined },
  ])], ["fail"]);
  assert.deepEqual([...turnFailuresContinuedByLaterSpeech([
    failure,
    { id: "fail-2", author: "claude:1", senderKind: "agent", senderInstanceId: "inst-1", provenance: "system_fact", metadata: evidence },
    speech,
  ])], ["fail", "fail-2"]);
  assert.equal(turnFailuresContinuedByLaterSpeech([speech, failure]).size, 0);
  assert.equal(turnFailuresContinuedByLaterSpeech([failure, { ...speech, recalledAt: "2026-10-26T22:30:00.000Z" }]).size, 0);
});

test("only a turn-failure notice with well-formed evidence is read as one", () => {
  const evidence = agentFailureEvidence("unexpected status 429");
  assert.deepEqual(turnFailureEvidenceOf({ xmatrixTurnFailure: true, xmatrixFailureEvidence: { version: 1, ...evidence } }), evidence);
  assert.equal(turnFailureEvidenceOf({ xmatrixFailureEvidence: evidence }), null);
  assert.equal(turnFailureEvidenceOf({ xmatrixTurnFailure: true }), null);
  assert.equal(turnFailureEvidenceOf({ xmatrixTurnFailure: true, xmatrixFailureEvidence: { ...evidence, category: "guess" } }), null);
});

test("quota presentation uses only the Hub classification, ahead of any HTTP rate limit", () => {
  const metadata = (usageLimit) => ({ xmatrixTurnFailure: true,
    xmatrixFailureEvidence: { ...agentFailureEvidence("unexpected status 429"), usageLimit } });
  assert.equal(turnProblem(turnFailureEvidenceOf(metadata({}))), "usage_limited");
  for (const malformed of [true, "usage_limited", []]) {
    assert.equal(turnProblem(turnFailureEvidenceOf(metadata(malformed))), "rate_limited");
  }
  assert.deepEqual(turnFailureEvidenceOf(metadata({ resetsAt: "not a date" })).usageLimit, {});
});
