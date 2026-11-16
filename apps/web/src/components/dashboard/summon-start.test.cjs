const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { mentionOnly, summonStartingUntil, SUMMON_STARTING_WINDOW_MS } = require("./summon-start.ts");
const { summonView } = require("./mention-invocation-state.ts");

test("a summon its send did not launch, and the old intent refusals, read as a mention", () => {
  for (const code of ["launch_not_requested", "summon_intent_explanation", "summon_intent_reference", "summon_intent_example"]) {
    assert.equal(mentionOnly(code), true, code);
  }
  assert.equal(mentionOnly("summon_intent_summon"), false);
  assert.equal(mentionOnly("registration_not_found"), false);
});

test("the starting state is bounded by its window and ignores bad clocks", () => {
  const sent = "2026-09-26T10:00:00.000Z";
  const at = Date.parse(sent);
  assert.equal(summonStartingUntil(sent, at + 1_000), at + SUMMON_STARTING_WINDOW_MS);
  assert.equal(summonStartingUntil(sent, at + SUMMON_STARTING_WINDOW_MS + 1), undefined);
  assert.equal(summonStartingUntil("not a time", at), undefined);
  assert.equal(summonStartingUntil(sent, at - 60_000), undefined, "a message from the future does not spin");
});

test("a started summon's steps begin at the environment Jev selected", () => {
  const at = "2026-09-26T10:00:00.000Z";
  const base = { launchId: "l", sourceMessageId: "m", channelId: "c", targetName: "claude",
    launchKind: "agent_mention_spawn", runId: "r", instanceId: "i", state: "connected", attempt: 0, retryable: false,
    createdAt: at, updatedAt: at, connectedAt: at };
  const view = summonView({ ...base, routingDecision: { source: "jev", evaluatedAt: at, rows: [],
    parameters: { rubricVersion: "registration-parameters-v2", evaluatedAt: at, inputDigest: "a".repeat(64),
      intent: { source: "author" }, selections: { model: "m", workspaceKind: "repo" },
      choices: [{ key: "workspace", selected: "workspace_0", probabilities: { workspace_0: 1 } }] } } });
  assert.deepEqual(view.steps.map(step => step.label), [
    "Environment selected", "Machine accepted", "Process started", "Joined channel", "Runtime ready", "Reasoning started",
  ]);
  assert.equal(summonView(base).steps[0].label, "Environment selected");
});
