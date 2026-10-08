import assert from "node:assert/strict";
import test from "node:test";
import { jevDecisions, jevReadings } from "./jev-decision-trace.ts";

const NOW = "2026-10-06T08:45:00.000Z";
const LATER = "2026-10-06T08:45:02.000Z";

function started(decisionId, at, questions, extra = {}) {
  return { refId: `decision:${decisionId}:started`, payload: { version: 1, decisionId, status: "started", at,
    input: { state: { summon: { text: "@auto" }, message: "@auto fix the flaky tests", channelContext: {
      hierarchy: [{ name: "space" }, { name: "general" }],
      messages: [{ sentAt: NOW, body: "CI is red on main" }, { body: "  " }], historyTruncated: true } }, questions },
    ...extra } };
}

function finished(decisionId, at, answers, status = "succeeded", extra = {}) {
  return { refId: `decision:${decisionId}:${status}`, payload: { version: 1, decisionId, status, at, answers, ...extra } };
}

test("a reading pairs what Jev was asked with what it answered, the answer first", () => {
  const [reading] = jevReadings([
    started("one", NOW, { modelEffort: { type: "choice", instructions: "Select a model.", criteria: {
      model_0: JSON.stringify({ model: "gpt-5.5", effort: "high", description: "Frontier model" }),
      model_1: JSON.stringify({ model: "", default: true }),
      model_2: JSON.stringify({ model: "gpt-5.4-mini" }),
    } } }),
    finished("one", LATER, { modelEffort: { choice: "model_1", probabilities: { model_0: 0.3, model_1: 0.5, model_2: 0.2 } } }),
  ]);
  assert.equal(reading.status, "succeeded");
  assert.equal(reading.message, "@auto fix the flaky tests");
  assert.equal(reading.summon, "@auto");
  assert.equal(reading.channel, "general");
  assert.deepEqual(reading.context, [{ body: "CI is red on main", sentAt: NOW }]);
  assert.equal(reading.contextTruncated, true);
  const [question] = reading.questions;
  assert.equal(question.label, "Model");
  assert.equal(question.instructions, "Select a model.");
  assert.deepEqual(question.options.map(option => [option.title, option.probability, option.selected]), [
    ["Harness default", 0.5, true],
    ["gpt-5.5 · high", 0.3, false],
    ["gpt-5.4-mini", 0.2, false],
  ]);
  assert.equal(question.options[1].detail, "Frontier model");
});

test("a reading still waiting has options without an answer, and a failed one says why", () => {
  const [pending] = jevReadings([started("p", NOW, { intent: { criteria: { summon: "Asks the Agent to work", mention: "Only names it" } } })]);
  assert.equal(pending.status, "pending");
  assert.equal(pending.questions[0].label, "Request");
  assert.equal(pending.questions[0].options.some(option => option.selected), false);
  const [failed] = jevReadings([started("f", NOW, {}), finished("f", LATER, undefined, "failed", { code: "timeout", reason: "no answer in 20s" })]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure, "timeout · no answer in 20s");
});

test("the two calls Jev makes about one mention read as one decision, oldest first", () => {
  const harness = { harness: { criteria: { harness_0: JSON.stringify({ harness: "codex", models: ["gpt-5.5"] }) } } };
  const model = { modelEffort: { criteria: { model_0: JSON.stringify({ model: "gpt-5.5" }) } } };
  // Records arrive newest first; the decision still reads in the order Jev asked.
  const readings = jevReadings([
    finished("second", LATER, { modelEffort: { choice: "model_0", probabilities: { model_0: 1 } } }),
    started("second", LATER, model),
    finished("first", NOW, { harness: { choice: "harness_0", probabilities: { harness_0: 0.77 } } }),
    started("first", NOW, harness),
  ]);
  assert.deepEqual(readings.map(reading => reading.decisionId), ["first", "second"]);
  const decisions = jevDecisions(readings);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].questions.map(question => question.label), ["Harness", "Model"]);
  assert.equal(decisions[0].questions[0].options[0].detail, "models: gpt-5.5");
  assert.deepEqual(decisions[0].refs, ["decision:first:succeeded", "decision:first:started", "decision:second:succeeded", "decision:second:started"]);
});

test("a failed call is not merged with a later retry of the same mention", () => {
  const decisions = jevDecisions(jevReadings([
    started("a", NOW, {}), finished("a", NOW, undefined, "failed", { reason: "busy" }),
    started("b", LATER, {}), finished("b", LATER, {}),
  ]));
  assert.deepEqual(decisions.map(decision => decision.status), ["failed", "succeeded"]);
});

test("a record that is not an object adds nothing", () => {
  assert.deepEqual(jevReadings([{ refId: "decision:x:started", payload: null }, { refId: "decision:y:started", payload: "text" }]), []);
});

test("each step names the routing model that answered it, when the record says", () => {
  const harness = { harness: { criteria: { harness_0: JSON.stringify({ harness: "codex" }) } } };
  const model = { modelEffort: { criteria: { model_0: JSON.stringify({ model: "gpt-5.5" }) } } };
  const [decision] = jevDecisions(jevReadings([
    started("h", NOW, harness), finished("h", NOW, { harness: { choice: "harness_0", probabilities: { harness_0: 1 } } }, "succeeded", { model: "vendor/router-a" }),
    started("m", LATER, model), finished("m", LATER, { modelEffort: { choice: "model_0", probabilities: { model_0: 1 } } }),
  ]));
  assert.deepEqual(decision.questions.map(question => [question.key, question.model]), [["harness", "vendor/router-a"], ["modelEffort", undefined]]);
});
