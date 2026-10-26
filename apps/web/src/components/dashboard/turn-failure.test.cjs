require("./typescript-require.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
const { agentFailureEvidence } = require("@xmatrix/protocol");
const { turnFailureEvidenceOf, turnProblem } = require("./turn-failure.ts");

/* The details failed turns reported in the last two weeks, read the way the Hub records them. */
const problem = (detail) => turnProblem(agentFailureEvidence(detail));

test("a failed turn's cause comes from the evidence the Hub recorded, not its prose", () => {
  assert.equal(problem("exceeded retry limit, last status: 429 Too Many Requests | codexErrorInfo=responseTooManyFailedAttempts | httpStatusCode=429"), "rate_limited");
  assert.equal(problem("unexpected status 403 Forbidden: Unknown error, url: https://chatgpt.com/backend-api/codex/responses"), "provider_refused");
  assert.equal(problem("The Claude process exited before responding. exit code: 1"), "process_exited");
  assert.equal(problem("request timed out after 120s"), "unreachable");
  assert.equal(problem("error_during_execution: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"), "unknown");
  // A number in prose is not an HTTP status.
  assert.equal(problem("wrote 429 lines before stopping"), "unknown");
});

test("only a turn-failure notice with well-formed evidence is read as one", () => {
  const evidence = agentFailureEvidence("unexpected status 429");
  assert.deepEqual(turnFailureEvidenceOf({ xmatrixTurnFailure: true, xmatrixFailureEvidence: { version: 1, ...evidence } }), evidence);
  assert.equal(turnFailureEvidenceOf({ xmatrixFailureEvidence: evidence }), null);
  assert.equal(turnFailureEvidenceOf({ xmatrixTurnFailure: true }), null);
  assert.equal(turnFailureEvidenceOf({ xmatrixTurnFailure: true, xmatrixFailureEvidence: { ...evidence, category: "guess" } }), null);
});
