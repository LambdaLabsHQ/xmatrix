import assert from "node:assert/strict";
import test from "node:test";
import { jevDecisions, jevReadings, placementReason, fitLevel, roomText } from "./jev-decision-trace.ts";

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

test("a fit score reads as its harness and levels, the scored level selected", () => {
  const input = { state: { message: "fix it" }, questions: { fit_0: { type: "score",
    instructions: `Rate how well. Harness: ${JSON.stringify({ harness: "codex", descriptions: [], models: [] })}`,
    criteria: ["Unsuitable: lacks it.", "Capable: nothing specific.", "Strong fit: a reason.", "Asked for: named."] } } };
  const [reading] = jevReadings([
    { refId: "decision:f:started", payload: { decisionId: "f", status: "started", at: "2026-10-08T14:00:00Z", input } },
    { refId: "decision:f:succeeded", payload: { decisionId: "f", status: "succeeded", at: "2026-10-08T14:00:01Z",
      answers: { fit_0: { score: 1.2, probabilities: { 0: 0, 1: 0.8, 2: 0.2, 3: 0 } } } } }]);
  const [question] = reading.questions;
  assert.equal(question.label, "Fit · codex");
  assert.deepEqual(question.options.map(option => [option.title, option.selected, option.probability]),
    [["Unsuitable", false, 0], ["Capable", true, 0.8], ["Strong fit", false, 0.2], ["Asked for", false, 0]]);
  assert.equal(question.options[1].detail, "nothing specific.");
});

test("the placement reason names the trade-off routing made", () => {
  const at = (harness, machineName, fit, headroom) => ({ harness, machineId: `${harness}@${machineName}`, machineName, fit, headroom, frontier: true, utility: 0 });
  assert.equal(placementReason([at("codex", "idle", 1 / 3, 0.85), at("claude", "busy", 0.68, -0.05)], true),
    "claude fits better, but busy is overloaded");
  assert.equal(placementReason([at("codex", "idle", 1 / 3, 0.85), at("claude", "warm", 0.68, 0.2)], true),
    "claude fits better, but warm is at 20% room");
  assert.equal(placementReason([at("codex", "idle", 1 / 3, 0.85), at("claude", "busy", 0.32, 0.1)], true),
    "All equally suited; most room here (85% room)");
  assert.equal(placementReason([at("claude", "warm", 0.68, 0.4), at("codex", "idle", 1 / 3, 0.85)], true), "Best suited, with 40% room");
  assert.equal(placementReason([at("codex", "idle", 1 / 3, 0.85)], false), "Most room for codex: 85% room");
  assert.deepEqual([fitLevel(0.32), fitLevel(0.68), fitLevel(0), fitLevel(1)], ["Capable", "Strong fit", "Unsuitable", "Asked for"]);
  assert.deepEqual([roomText(undefined), roomText(-0.2), roomText(0.414)], ["room unknown", "overloaded", "41% room"]);
});

test("a fit score's answer is the level Jev weighed most, matching the share shown", () => {
  const input = { state: { message: "x" }, questions: { fit_0: { type: "score", instructions: `Harness: ${JSON.stringify({ harness: "claude" })}`,
    criteria: ["Unsuitable: a", "Capable: b", "Strong fit: c", "Asked for: d"] } } };
  const [reading] = jevReadings([
    { refId: "decision:g:started", payload: { decisionId: "g", status: "started", at: "2026-10-08T14:00:00Z", input } },
    { refId: "decision:g:succeeded", payload: { decisionId: "g", status: "succeeded", at: "2026-10-08T14:00:01Z",
      answers: { fit_0: { score: 2.05, probabilities: { 0: 0.1, 1: 0.32, 2: 0.01, 3: 0.57 } } } } }]);
  const chosen = reading.questions[0].options.find(option => option.selected);
  assert.deepEqual([chosen.title, chosen.probability], ["Asked for", 0.57]);
});
