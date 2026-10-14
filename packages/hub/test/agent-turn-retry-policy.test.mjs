import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceTurnRetry, parseHubTurnRetry, turnRetryNotice } from "../src/agent-turn-retry-policy.ts";

const failure = (turn, extra = {}) => ({ type: "agent_turn_retry", action: "failed", operationId: "operation",
  requestId: `request-${turn}`, threadId: "thread", turnId: turn, safeToContinue: true,
  errorMessage: "Selected model is at capacity. Please try a different model.", ...extra });

test("Hub owns the 5/15/30 second budget across reconstructed state and ignores caller budgets", () => {
  let state;
  let now = 1_000;
  for (const [index, delay] of [5_000, 15_000, 30_000].entries()) {
    const before = state;
    state = advanceTurnRetry(state, failure(`turn-${index}`, { attempt: 100, delayMs: 0,
      ...(before ? { attemptToken: before.attemptToken } : {}) }), now, `permit-${index}`);
    assert.equal(state.attempt, index + 1);
    assert.equal(state.dueAt, now + delay);
    assert.match(turnRetryNotice(state), new RegExp(`retry ${index + 1}/3`));
    assert.strictEqual(advanceTurnRetry(state, failure(`turn-${index}`), now + 1, "other-permit"), state);
    now = state.dueAt;
    state = parseHubTurnRetry(JSON.parse(JSON.stringify({ ...state, state: "issued", notice: "" })));
  }
  state = advanceTurnRetry(state, failure("last", { attemptToken: state.attemptToken }), now, "unused");
  assert.equal(state.state, "exhausted");
  assert.equal(state.attempt, 3);
  assert.match(turnRetryNotice(state), /stopped retrying/u);
  assert.throws(() => advanceTurnRetry(state, failure("late", { attemptToken: "unused" }), now, "no"), /does not match/u);
});

test("Hub classifies the observed error and refuses quota, auth, cancellation and partial execution", () => {
  for (const errorMessage of ["Usage limit exceeded", "Unauthorized", "Request interrupted", "Unrelated internal error"])
    assert.equal(advanceTurnRetry(undefined, failure("turn", { errorMessage }), 1_000, "token").state, "ineligible");
  assert.equal(advanceTurnRetry(undefined, failure("turn", { safeToContinue: false }), 1_000, "token").state, "unsafe");
});

test("only the exact issued permit can advance the same thread and operation", () => {
  const waiting = advanceTurnRetry(undefined, failure("turn"), 1_000, "permit");
  assert.throws(() => advanceTurnRetry(waiting, failure("next", { attemptToken: "permit" }), 2_000, "next"), /does not match/u);
  const issued = { ...waiting, state: "issued" };
  for (const extra of [{ attemptToken: "wrong" }, { attemptToken: "permit", threadId: "foreign" },
    { attemptToken: "permit", operationId: "foreign" }])
    assert.throws(() => advanceTurnRetry(issued, failure("next", extra), 6_000, "next"));
});

test("cancellation and completion are terminal and survive replay", () => {
  const waiting = advanceTurnRetry(undefined, failure("turn"), 1_000, "permit");
  for (const action of ["cancelled", "completed"]) {
    const terminal = advanceTurnRetry(waiting, { operationId: "operation", action }, 2_000, "unused");
    assert.equal(terminal.state, action);
    assert.strictEqual(advanceTurnRetry(terminal, failure("turn"), 3_000, "new"), terminal);
    assert.equal(advanceTurnRetry(terminal, { operationId: "operation", action: "cancelled" }, 3_000, "new").state, action);
    assert.throws(() => advanceTurnRetry(terminal, failure("other-turn", { attemptToken: "permit" }), 3_000, "new"));
  }
});

test("an error Hub does not retry posts no retry notice; the turn failure reports it", () => {
  const state = advanceTurnRetry(undefined, failure("turn", { errorMessage: "You've hit your usage limit." }), 1_000, "token");
  assert.equal(state.state, "ineligible");
  assert.equal(state.notice, "");
});

test("Hub-reported outcomes show the original error, and its text cannot summon anyone", () => {
  const unsafe = advanceTurnRetry(undefined, failure("turn", { safeToContinue: false,
    errorMessage: "Selected model is at capacity.\nAsk @auto ＠codex:2 later" }), 1_000, "token");
  const notice = turnRetryNotice({ ...unsafe, agentLabel: "@auto\nlaunch:force" });
  assert.match(notice, /Error: Selected model is at capacity\. Ask ﹫auto ﹫codex:2 later$/u);
  assert.doesNotMatch(notice, /[@＠`\n]/u);
  for (const state of ["exhausted", "expired", "cancelled"])
    assert.match(turnRetryNotice({ ...unsafe, state }), /Error: Selected model is at capacity/u);
  assert.doesNotMatch(turnRetryNotice({ ...unsafe, state: "completed" }), /Error:/u);
});
