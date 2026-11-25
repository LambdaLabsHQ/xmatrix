const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { askMessage } = require("./ask-message.ts");

const passage = { text: "Postgres keeps one backend process per connection", label: "Pool notes", href: "https://a.test/pool" };

// The box on a page holds only the question (Daniel 2026-11-23): the message still opens with the passage.
test("the question goes out under the quoted passage", async () => {
  const { body, invocationSelections } = await askMessage(passage, "is this right?", undefined, "space-1");
  assert.equal(body, "> Postgres keeps one backend process per connection\n\n— [Pool notes](https://a.test/pool)\n\nis this right?");
  assert.equal(invocationSelections, undefined);
});

test("an Agent picked in the question still names the same words after the quote", async () => {
  const question = "is this right? @claude please check";
  const start = question.indexOf("@claude");
  const picked = { schemaVersion: 1, sourceRevision: 1, sourceBodyHash: "unused",
    selections: [{ start, end: start + 7, text: "@claude", target: { kind: "capability", harness: "claude" } }] };
  const { body, invocationSelections } = await askMessage(passage, question, picked, "space-1");
  const [selection] = invocationSelections.selections;
  assert.equal(body.slice(selection.start, selection.end), "@claude");
  assert.ok(selection.start > body.indexOf("is this right?"));
});

test("an oversized quote shortens cleanly without dropping explicit @ Agent selections", async () => {
  const hugePassage = { text: "a".repeat(70 * 1024), label: "Huge page", href: "https://a.test/huge" };
  const question = "@claude summarize this";
  const picked = {
    schemaVersion: 1,
    sourceRevision: 1,
    sourceBodyHash: "unused",
    selections: [{ start: 0, end: 7, text: "@claude", target: { kind: "capability", harness: "claude" } }],
  };
  const { body, invocationSelections } = await askMessage(hugePassage, question, picked, "space-1");
  assert.ok(invocationSelections, "explicit @ invocation selection is preserved");
  const [selection] = invocationSelections.selections;
  assert.equal(body.slice(selection.start, selection.end), "@claude");
});

test("without a spaceId, explicit @ Agent selections throw instead of silently dropping quote or mention", async () => {
  const question = "@claude check this";
  const picked = {
    schemaVersion: 1,
    sourceRevision: 1,
    sourceBodyHash: "unused",
    selections: [{ start: 0, end: 7, text: "@claude", target: { kind: "capability", harness: "claude" } }],
  };
  await assert.rejects(() => askMessage(passage, question, picked, null), /Couldn't attach the selected quote/);
});
