import assert from "node:assert/strict";
import test from "node:test";

import {
  automationEvaluatorBinding,
} from "../src/automation-evaluator-binding.ts";

test("Automation evaluator binding reads canonical v3 input", () => {
  assert.deepEqual(automationEvaluatorBinding({
    input: {
      envRef: {
        actor: { kind: "agent", id: "agent:1" },
        authorityRootUserId: "user:owner",
      },
    },
    authorityRootUserId: "user:fallback",
  }), {
    actor: { kind: "agent", id: "agent:1" },
    authorityRootUserId: "user:owner",
  });
});

test("Automation evaluator binding recovers Human-owned legacy tasks without input", () => {
  assert.deepEqual(automationEvaluatorBinding({
    ownerUserId: "user:owner",
    authorityRootUserId: "user:owner",
  }), {
    actor: { kind: "user", id: "user:owner" },
    authorityRootUserId: "user:owner",
  });
});

test("Automation evaluator binding fails closed for malformed or ambiguous authority", () => {
  assert.equal(automationEvaluatorBinding(undefined), undefined);
  assert.equal(automationEvaluatorBinding({ input: {} }), undefined);
  assert.equal(automationEvaluatorBinding({
    input: { envRef: { actor: { kind: "service", id: "agent:1" } } },
    ownerUserId: "user:owner",
    authorityRootUserId: "user:owner",
  }), undefined);
  assert.equal(automationEvaluatorBinding({
    input: { envRef: { authorityRootUserId: 42 } },
    ownerUserId: "user:owner",
    authorityRootUserId: "user:owner",
  }), undefined);
});
