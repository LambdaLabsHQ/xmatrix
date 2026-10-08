const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { declinedIntent, draftSummons, toggleLaunchForce, readingIntentUntil, INTENT_READING_WINDOW_MS } = require("./summon-intent.ts");
const { summonView, summonIntentNote } = require("./mention-invocation-state.ts");

test("only the three intent refusals read as a declined summon", () => {
  assert.equal(declinedIntent("summon_intent_explanation"), "explanation");
  assert.equal(declinedIntent("summon_intent_reference"), "reference");
  assert.equal(declinedIntent("summon_intent_example"), "example");
  assert.equal(declinedIntent("summon_intent_summon"), undefined);
  assert.equal(declinedIntent("registration_not_found"), undefined);
});

test("the Force toggle adds and removes exactly launch:force on its own summon", () => {
  const draft = "@claude repo:owner/repo fix it, then ask @codex";
  const [first, second] = draftSummons(draft);
  assert.equal(first.forced, false);
  const forced = toggleLaunchForce(draft, first.mention);
  assert.equal(forced.draft, "@claude repo:owner/repo launch:force fix it, then ask @codex");
  assert.equal(forced.draft.slice(0, forced.caret), "@claude repo:owner/repo launch:force");
  const [again] = draftSummons(forced.draft);
  assert.equal(again.forced, true);
  assert.equal(toggleLaunchForce(forced.draft, again.mention).draft, draft);
  assert.equal(toggleLaunchForce(draft, second.mention).draft, `${draft} launch:force`);
});

test("a summon written as code or a quote is not offered for intent", () => {
  assert.deepEqual(draftSummons("write `@claude repo:a/b` to summon"), []);
  assert.deepEqual(draftSummons("> @claude fix it"), []);
});

test("the reading shimmer is bounded by the reading window and ignores bad clocks", () => {
  const sent = "2026-09-26T10:00:00.000Z";
  const at = Date.parse(sent);
  assert.equal(readingIntentUntil(sent, at + 1_000), at + INTENT_READING_WINDOW_MS);
  assert.equal(readingIntentUntil(sent, at + INTENT_READING_WINDOW_MS + 1), undefined);
  assert.equal(readingIntentUntil("not a time", at), undefined);
  assert.equal(readingIntentUntil(sent, at - 60_000), undefined, "a message from the future does not spin");
});

test("a started summon first says how it was read as a request", () => {
  const at = "2026-09-26T10:00:00.000Z";
  const base = { launchId: "l", sourceMessageId: "m", channelId: "c", targetName: "claude",
    launchKind: "agent_mention_spawn", runId: "r", instanceId: "i", state: "connected", attempt: 0, retryable: false,
    createdAt: at, updatedAt: at, connectedAt: at };
  const parameters = (intent) => ({ rubricVersion: "registration-parameters-v2", evaluatedAt: at,
    inputDigest: "a".repeat(64), intent,
    selections: { model: "m", workspaceKind: "repo" },
    choices: [
      { key: "modelEffort", selected: "model_0", probabilities: { model_0: 1 } },
      { key: "workspace", selected: "workspace_0", probabilities: { workspace_0: 1 } }] });
  const jev = summonView({ ...base, routingDecision: { source: "jev", evaluatedAt: at, rows: [],
    parameters: parameters({ source: "jev", selected: "summon", probabilities: { summon: .96, reference: .02, explanation: .01, example: .01 } }) } });
  assert.deepEqual(jev.steps.map(step => step.label), [
    "Read as a request", "Environment selected", "Machine accepted", "Process started", "Joined channel", "Runtime ready", "Reasoning started",
  ]);
  assert.equal(jev.steps[0].note, "xMatrix · 96%");
  const forced = summonView({ ...base, routingDecision: { source: "jev", evaluatedAt: at, rows: [], parameters: parameters({ source: "author" }) } });
  assert.equal(forced.steps[0].label, "Started on the author's request");
  assert.equal(forced.steps[0].note, "launch:force");
  assert.equal(summonIntentNote(undefined), undefined);
  assert.equal(summonView(base).steps[0].label, "Environment selected");
});
