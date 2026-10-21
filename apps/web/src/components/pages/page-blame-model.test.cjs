const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { carryPageDocKnown, markdownToPageDoc, pageBlameFirst, pageBlameStep } = require("@xmatrix/protocol/page-document");
const { blameDoc, blameOf } = require("./page-blame-model.ts");

const daniel = { kind: "user", id: "u1", label: "Daniel" };
const claude = { kind: "agent", id: "c:1", label: "claude" };
const revision = (number, author, createdAt, conversationIds = []) =>
  ({ revision: number, kind: "edit", authors: [author], conversationIds, basedOnRevision: null, createdAt });

const one = "# Login\n\nNo setup links by email; keep sessions 30 days.\n";
const two = "# Login\n\nNo setup links by email; set a passkey in the app; keep sessions 30 days.\n";
const blame = {
  pageId: "p", revision: 2, body: two,
  runs: pageBlameStep(one, pageBlameFirst(one, 1), two, 2),
  revisions: [revision(1, daniel, "2026-10-18T09:32:00.000Z"), revision(2, claude, "2026-10-21T14:05:00.000Z", ["chat"])],
  conversations: [{ conversationId: "chat", name: "Login flow" }],
};

/** `from`..`to` of `doc` around the first `text` in it. */
function rangeOf(doc, text) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text.indexOf(text);
    if (at >= 0) found = { from: pos + at, to: pos + at + text.length };
    return false;
  });
  return found;
}

test("a passage one writer wrote names them, when, and the conversation it came from", () => {
  const base = blameDoc(blame);
  const now = markdownToPageDoc(two);
  const { from, to } = rangeOf(now, "set a passkey in the app");
  const summary = blameOf(base, carryPageDocKnown(base.doc, base.known, now), now, from, to);
  assert.deepEqual(summary.writers.map((writer) => [writer.author.label, writer.revision, writer.conversation]),
    [["claude", 2, { id: "chat", name: "Login flow" }]]);
  assert.equal(summary.writing, false);
});

test("a paragraph several wrote lists each, newest first, with their stretches", () => {
  const base = blameDoc(blame);
  const now = markdownToPageDoc(two);
  const { from } = rangeOf(now, "No setup");
  const { to } = rangeOf(now, "30 days.");
  const summary = blameOf(base, carryPageDocKnown(base.doc, base.known, now), now, from, to);
  assert.deepEqual(summary.writers.map((writer) => writer.author.label), ["claude", "Daniel"]);
  assert.equal(summary.writers[1].conversation, null, "a revision from no readable conversation names none");
  assert.equal(summary.stretches.length, 3, "Daniel's, then claude's, then Daniel's again");
});

test("text typed since the newest revision reads as being written", () => {
  const base = blameDoc(blame);
  const now = markdownToPageDoc(two.replace("30 days", "90 days"));
  const { from, to } = rangeOf(now, "keep sessions 90 days");
  const summary = blameOf(base, carryPageDocKnown(base.doc, base.known, now), now, from, to);
  assert.equal(summary.writing, true);
  assert.deepEqual(summary.writers.map((writer) => writer.author.label), ["Daniel"]);
});
