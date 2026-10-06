import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentInvocationSelections } from "../dist/agent-invocation-selection.js";

const key = { spaceId: "a", ownerUserId: "owner", machineId: "machine", harness: "codex" };
const source = { spaceId: "a", body: "🙂 @codex:new:owner/repo do this", revision: 3, bodyHash: "a".repeat(64) };
const selection = { start: 3, end: 24, text: "@codex:new:owner/repo", target: { kind: "registration", key } };
// End offsets are UTF-16, including the initial emoji's surrogate pair.
selection.end = selection.start + selection.text.length;
const envelope = { schemaVersion: 1, sourceRevision: 3, sourceBodyHash: source.bodyHash, selections: [selection] };

test("explicit selection binds a composite location without inserting an ID in the body", () => {
  assert.deepEqual(parseAgentInvocationSelections(envelope, source), envelope);
  const other = { ...selection, target: { kind: "registration", key: { ...key, machineId: "other" } } };
  assert.equal(parseAgentInvocationSelections({ ...envelope, selections: [other] }, source)
    .selections[0].target.key.machineId, "other");
});

test("capability intent is distinct from an explicit location", () => {
  const value = { ...envelope, selections: [{ ...selection, target: { kind: "capability", harness: "claude_code" } }] };
  assert.equal(parseAgentInvocationSelections(value, source).selections[0].target.harness, "claude");
  for (const target of [{ kind: "capability", harness: "codex", key }, { kind: "registration", key, harness: "codex" },
    { kind: "registration", key: { ...key, spaceId: "b" } }, { kind: "profile", profileId: "old-id" }]) {
    assert.throws(() => parseAgentInvocationSelections({ ...envelope, selections: [{ ...selection, target }] }, source));
  }
});

test("edits, stale revision, overlapping spans and caller-added authority fail closed", () => {
  for (const patch of [{ sourceRevision: 2 }, { sourceBodyHash: "b".repeat(64) },
    { selections: [selection, selection] }, { principal: "owner" },
    { selections: [{ ...selection, end: selection.end - 1 }] },
    { selections: [{ ...selection, target: { kind: "registration", key: { ...key, configId: "extra" } } }] }]) {
    assert.throws(() => parseAgentInvocationSelections({ ...envelope, ...patch }, source));
  }
  assert.throws(() => parseAgentInvocationSelections(envelope, { ...source, body: source.body.replace("codex", "grok") }));
});

test("quoted, escaped and code mentions cannot become operational selections", () => {
  for (const body of ["`@codex`", "> @codex", "\\@codex", "hello@codex", "[x](@codex)", "```\n@codex\n```", "~~@codex~~"]) {
    const start = body.indexOf("@codex");
    assert.throws(() => parseAgentInvocationSelections({ ...envelope, selections: [{ ...selection,
      start, end: start + 6, text: "@codex" }] }, { ...source, body }));
  }
});

test("selection spans preserve the existing quoted workspace grammar", () => {
  const text = '@codex:new:"/Users/owner/My Project"';
  const value = { ...envelope, selections: [{ ...selection, start: 0, end: text.length, text }] };
  assert.equal(parseAgentInvocationSelections(value, { ...source, body: `${text} fix the build` }).selections[0].text, text);
  assert.throws(() => parseAgentInvocationSelections({ ...value, selections: [{ ...value.selections[0],
    text: `${text} another word`, end: text.length + 13 }] }, { ...source, body: `${text} another word` }));
});
