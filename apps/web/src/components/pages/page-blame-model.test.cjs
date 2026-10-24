const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { carryPageDocKnown, markdownToPageDoc, pageBlameFirst, pageBlameStep } = require("@xmatrix/protocol/page-document");
const { blameDoc, blameOf, pageWriters } = require("./page-blame-model.ts");

const daniel = { kind: "user", id: "u1", label: "Daniel" };
const claude = { kind: "agent", id: "c:1", label: "claude", ownerUserId: "u1" };
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

test("the page's authors are whoever has words in it now, most words first, with where their words are", () => {
  const base = blameDoc(blame);
  const now = markdownToPageDoc(two);
  const writers = pageWriters(base, carryPageDocKnown(base.doc, base.known, now), now);
  assert.deepEqual(writers.map((writer) => writer.author.label), ["Daniel", "claude"]);
  const claudes = writers[1].ranges.map(({ from, to }) => now.textBetween(from, to));
  assert.ok(claudes.some((text) => text.includes("set a passkey in the app")), claudes.join("|"));
});

test("someone whose words were all taken out is no longer an author", () => {
  const base = blameDoc(blame);
  const now = markdownToPageDoc(one);
  const writers = pageWriters(base, carryPageDocKnown(base.doc, base.known, now), now);
  assert.deepEqual(writers.map((writer) => writer.author.label), ["Daniel"]);
});

test("an Agent's Runs are one author, in the byline and beside a paragraph", () => {
  const three = two.replace("keep sessions 30 days", "keep sessions 30 days; sign out everywhere");
  const base = blameDoc({
    ...blame, revision: 3, body: three,
    runs: pageBlameStep(two, blame.runs, three, 3),
    revisions: [...blame.revisions, revision(3, { ...claude, id: "c:2" }, "2026-10-22T08:00:00.000Z")],
  });
  const now = markdownToPageDoc(three);
  const carried = carryPageDocKnown(base.doc, base.known, now);
  assert.deepEqual(pageWriters(base, carried, now).map((writer) => writer.author.label), ["Daniel", "claude"]);
  const { from } = rangeOf(now, "No setup");
  const { to } = rangeOf(now, "everywhere");
  assert.deepEqual(blameOf(base, carried, now, from, to).writers.map((writer) => [writer.author.label, writer.revision]),
    [["claude", 3], ["Daniel", 1]]);
});

test("another person's Agent of the same name is an author of its own", () => {
  const three = two.replace("keep sessions 30 days", "keep sessions 30 days; sign out everywhere");
  const base = blameDoc({
    ...blame, revision: 3, body: three,
    runs: pageBlameStep(two, blame.runs, three, 3),
    revisions: [...blame.revisions, revision(3, { ...claude, id: "c:2", ownerUserId: "u2" }, "2026-10-22T08:00:00.000Z")],
  });
  const now = markdownToPageDoc(three);
  assert.equal(pageWriters(base, carryPageDocKnown(base.doc, base.known, now), now).length, 3);
});
