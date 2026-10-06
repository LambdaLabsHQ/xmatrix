const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const {
  agentInstanceTagChanges,
  agentInstanceTagCommandBody,
  agentInstanceTagEdits,
} = require("./agent-instance-tag-edits.ts");

const OPUS = {
  id: "opus",
  model: "claude-opus-5",
  displayName: "Opus 5",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "high", description: "Think longer" },
  ],
};

function instance(overrides) {
  return {
    id: "instance-1",
    label: "claude",
    model: "claude-opus-5",
    effort: "medium",
    models: [OPUS],
    commands: [
      { token: "/model", label: "Switch model", mode: "typed", argumentSource: "agent-models" },
      { token: "/effort", label: "Effort", mode: "typed", argumentSource: "agent-efforts" },
      { token: "/compact", label: "Compact context", mode: "passthrough" },
    ],
    ...overrides,
  };
}

test("an editable tag is one the instance advertises a catalog command for", () => {
  const edits = agentInstanceTagEdits(instance());
  assert.deepEqual(edits.map((edit) => edit.chipId), ["model", "effort"]);
  assert.equal(edits[0].token, "/model");
  assert.equal(edits[0].current, "claude-opus-5");
  assert.deepEqual(edits[0].options, [
    { value: "claude-opus-5", label: "Opus 5" },
  ]);
  // The effort catalog is the current model's, and its default is offered too.
  assert.deepEqual(edits[1].options.map((option) => option.value), ["low", "high", "medium"]);
});

test("a tag with no catalog reports but does not offer an editor", () => {
  // A passthrough command takes no argument; a typed one whose catalog the
  // runtime never reported has nothing to choose from. Neither is editable.
  assert.deepEqual(agentInstanceTagEdits(instance({ models: [] })), []);
  assert.deepEqual(
    agentInstanceTagEdits(instance({ commands: [{ token: "/compact", label: "Compact", mode: "passthrough" }] })),
    [],
  );
  assert.deepEqual(agentInstanceTagEdits(instance({ commands: [] })), []);
});

test("only a staged value that differs from the live one is a change", () => {
  const edits = agentInstanceTagEdits(instance());
  assert.deepEqual(agentInstanceTagChanges(edits, {}), []);
  // Re-picking what is already live is not an edit, so it sends nothing.
  assert.deepEqual(agentInstanceTagChanges(edits, { effort: "medium" }), []);
  assert.deepEqual(
    agentInstanceTagChanges(edits, { effort: "high" }).map((edit) => edit.chipId),
    ["effort"],
  );
});

test("the whole tag edit is one message with a statement per changed tag", () => {
  const edits = agentInstanceTagEdits(instance({ model: "claude-sonnet-5" }));
  assert.equal(
    agentInstanceTagCommandBody("@claude:2", edits, { model: "claude-opus-5", effort: "high" }),
    "@claude:2 /model claude-opus-5\n@claude:2 /effort high",
  );
  // The address is written once, however the caller spelled it.
  assert.equal(
    agentInstanceTagCommandBody("claude:2", edits, { effort: "high" }),
    "@claude:2 /effort high",
  );
  assert.equal(agentInstanceTagCommandBody("@claude:2", edits, {}), undefined);
  assert.equal(agentInstanceTagCommandBody("", edits, { effort: "high" }), undefined);
});
