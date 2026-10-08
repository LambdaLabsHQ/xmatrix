import assert from "node:assert/strict";
import test from "node:test";
import { consumeJevFillArrival, decidedMachineLabel, jevFilledAnnouncement, jevFilledTags, jevFilledTagsForHandoff, jevFillShouldArrive, launchMachineLabel, noteJevReading } from "./jev-filled-tags.ts";

const DIGEST = "a".repeat(64);

function evidence(extra = {}) {
  return {
    rubricVersion: "registration-parameters-v7",
    evaluatedAt: "2026-10-06T08:45:00.000Z",
    inputDigest: DIGEST,
    selections: { model: "grok-4", effort: "high", workspaceKind: "repo", repo: "LambdaLabsHQ/xmatrix" },
    choices: [
      { key: "modelEffort", selected: "model_1", probabilities: { model_0: 0.2, model_1: 0.8 } },
      { key: "workspace", selected: "workspace_0", probabilities: { workspace_0: 1 } },
      { key: "placement", selected: "placement_stationary", probabilities: { placement_any: 0.3, placement_stationary: 0.7 } },
    ],
    harness: { inputDigest: DIGEST, selected: "grok", probabilities: { grok: 0.7, claude: 0.3 } },
    ...extra,
  };
}

/** The fields a parsed summon would carry. Offsets are unused by the fill. */
function mention(tags, error) {
  return { start: 0, end: 0, text: "", tags, conditions: [], ...(error ? { error } : {}) };
}

test("Jev's choices fill only the fields the author left blank, in the order Jev made them", () => {
  const tags = jevFilledTags(mention({}), evidence());
  assert.deepEqual(tags, [
    { field: "harness", value: "grok" },
    { field: "model", value: "grok-4" },
    { field: "effort", value: "high" },
    { field: "repo", value: "LambdaLabsHQ/xmatrix" },
  ]);
  assert.equal(jevFilledAnnouncement(tags),
    "xMatrix filled harness:grok, model:grok-4, effort:high, repo:LambdaLabsHQ/xmatrix");
});

test("a field the author wrote is not drawn again, even when Jev disagrees", () => {
  const tags = jevFilledTags(mention({ harness: "grok", repo: "other/repo", model: "opus" }), evidence());
  assert.deepEqual(tags.map(tag => tag.field), ["effort"]);
});

test("an older placement choice is not a tag", () => {
  assert.equal(jevFilledTags(mention({}), evidence()).some(tag => tag.field === "placement"), false);
});

test("routing's Machine is a machine tag, and a Machine the author named is not drawn again", () => {
  const tags = jevFilledTags(mention({}), evidence(), "Workstation");
  // Routing binds the Machine after Jev has chosen, so its tag comes last.
  assert.deepEqual(tags.map(tag => tag.field), ["harness", "model", "effort", "repo", "machine"]);
  assert.deepEqual(tags.find(tag => tag.field === "machine"), { field: "machine", value: "Workstation", source: "routing" });
  assert.equal(jevFilledAnnouncement(tags),
    "xMatrix filled harness:grok, model:grok-4, effort:high, repo:LambdaLabsHQ/xmatrix. Routing filled machine:Workstation");
  assert.deepEqual(jevFilledTags(mention({ machine: "Laptop" }), evidence(), "Workstation").map(tag => tag.field),
    ["harness", "model", "effort", "repo"]);
});

test("a Machine tag uses the owner's name or the recorded binding, never a hostname", () => {
  const selected = { machineId: "machine:abc", machineLabel: "星豆号" };
  assert.equal(decidedMachineLabel({ selected }), "星豆号");
  assert.equal(decidedMachineLabel({ recorded: { id: "machine:abc", name: "Workstation" } }), "Workstation");
  assert.equal(decidedMachineLabel({}), undefined);
  assert.equal(decidedMachineLabel({ written: "Laptop", recorded: { id: "machine:abc", name: "Workstation" } }), undefined);
  assert.equal(decidedMachineLabel({ recorded: { id: "machine:abc", name: "11111111-1111-1111-1111-111111111111" } }), undefined);
  assert.equal(decidedMachineLabel({ recorded: { id: "machine:abc", name: "Registered machine" } }), undefined);
  assert.equal(decidedMachineLabel({ selected: { machineId: "machine:abc" } }), undefined);
  const onlyMachine = jevFilledTags(mention({}), undefined, decidedMachineLabel({ recorded: { id: "machine:abc", name: "星豆号" } }));
  assert.deepEqual(onlyMachine, [{ field: "machine", value: "星豆号", source: "routing" }]);
  assert.equal(jevFilledAnnouncement(onlyMachine), "Routing filled machine:星豆号");
});

test("a directory Jev chose is never named", () => {
  const local = evidence({
    selections: { model: "grok-4", workspaceKind: "local-path" },
    harness: undefined,
    choices: [
      { key: "modelEffort", selected: "model_0", probabilities: { model_0: 1 } },
      { key: "workspace", selected: "workspace_0", probabilities: { workspace_0: 1 } },
    ],
  });
  assert.deepEqual(jevFilledTags(mention({}), local), [{ field: "model", value: "grok-4" }]);
});

test("a skipped model decision adds no model or effort tag to summons or handoffs", () => {
  const parameters = evidence({ rubricVersion: "registration-parameters-v9",
    selections: { workspaceKind: "repo", repo: "LambdaLabsHQ/xmatrix" },
    choices: [{ key: "workspace", selected: "workspace_0", probabilities: { workspace_0: 1 } }] });
  assert.deepEqual(jevFilledTags(mention({}), parameters).map(tag => tag.field), ["harness", "repo"]);
  assert.deepEqual(jevFilledTagsForHandoff("grok", parameters, "Workstation").map(tag => tag.field), ["repo", "machine"]);
});

test("@auto shows the harness Jev picked; a named successor does not repeat it", () => {
  assert.deepEqual(jevFilledTagsForHandoff("auto", evidence()).map(tag => tag.field),
    ["harness", "model", "effort", "repo"]);
  assert.deepEqual(jevFilledTagsForHandoff("  Grok ", evidence()).map(tag => tag.field),
    ["model", "effort", "repo"]);
  assert.deepEqual(jevFilledTagsForHandoff("auto", undefined), []);
  const decision = { rows: [{ selected: true, machineId: "machine:abc", machineLabel: "星豆号" }], machine: { id: "machine:abc", name: "Workstation" } };
  assert.equal(launchMachineLabel(decision), "星豆号");
  assert.equal(launchMachineLabel({ rows: [], machine: { id: "machine:abc", name: "Workstation" } }), "Workstation");
  assert.equal(launchMachineLabel(decision, "Laptop"), undefined);
  const picked = jevFilledTagsForHandoff("auto", evidence(), launchMachineLabel(decision));
  assert.deepEqual(picked.map(tag => tag.field), ["harness", "model", "effort", "repo", "machine"]);
  assert.deepEqual(picked.find(tag => tag.field === "machine"), { field: "machine", value: "星豆号", source: "routing" });
  assert.deepEqual(jevFilledTagsForHandoff("Grok", evidence(), "Workstation").map(tag => tag.field),
    ["model", "effort", "repo", "machine"]);
});

test("a broken summon and a missing decision add nothing", () => {
  assert.deepEqual(jevFilledTags(mention({}, "Invalid launch parameter value."), evidence()), []);
  assert.deepEqual(jevFilledTags(mention({}), undefined), []);
  assert.equal(jevFilledAnnouncement([]), undefined);
});

test("the arrival plays once, only after a reading the reader actually saw", () => {
  noteJevReading("message:1");
  assert.equal(jevFillShouldArrive("message:1"), true);
  assert.equal(jevFillShouldArrive("message:2"), false);
  consumeJevFillArrival("message:1");
  assert.equal(jevFillShouldArrive("message:1"), false);
});

test("a jointly placed harness is filled by routing beside the machine", () => {
  const parameters = evidence({ rubricVersion: "registration-parameters-v10", harness: undefined,
    fit: { inputDigest: DIGEST, scores: { codex: { score: 1, probabilities: {} }, claude: { score: 1, probabilities: {} } } },
    placement: { profile: "balanced", ranking: [{ harness: "codex", machineId: "m", fit: 1 / 3, headroom: 0.86, frontier: true, utility: 0.334 }] } });
  assert.deepEqual(jevFilledTags(mention({}), parameters, "srv2006562").slice(-2), [
    { field: "harness", value: "codex", source: "routing" }, { field: "machine", value: "srv2006562", source: "routing" }]);
  assert.equal(jevFilledTags(mention({ harness: "claude" }), parameters).some(tag => tag.field === "harness"), false);
  // One harness had no fit to compare: nothing was chosen about it.
  assert.equal(jevFilledTags(mention({}), { ...parameters, fit: undefined }).some(tag => tag.field === "harness"), false);
});
