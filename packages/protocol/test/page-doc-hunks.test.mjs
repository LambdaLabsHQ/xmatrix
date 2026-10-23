import assert from "node:assert/strict";
import { test } from "node:test";
import { Slice } from "prosemirror-model";
import { markdownToPageDoc, pageDocHunks, pageDocToMarkdown } from "../dist/page-document.js";

/** The document after taking only the hunks at `indexes`, as markdown. */
function taking(now, suggested, indexes) {
  let doc = markdownToPageDoc(now);
  const hunks = pageDocHunks(doc, markdownToPageDoc(suggested));
  // Later hunks first, so earlier positions still hold.
  for (const index of [...indexes].sort((a, b) => b - a)) {
    const hunk = hunks[index];
    doc = doc.replace(hunk.from, hunk.to, new Slice(hunk.content, 0, 0));
  }
  return { markdown: pageDocToMarkdown(doc), count: hunks.length };
}

test("a suggestion is offered paragraph by paragraph, each taken on its own", () => {
  const now = "# Relay\n\nPlanned for next week.\n\n## Notes\n\nnone\n";
  const suggested = "# Relay\n\nShipped this week.\n\n## Notes\n\nnone yet\n\n## Risks\n\nLate reviews\n";
  assert.equal(taking(now, suggested, []).count, 3);
  // Taking only the first leaves the others as they are.
  assert.equal(taking(now, suggested, [0]).markdown, "# Relay\n\nShipped this week.\n\n## Notes\n\nnone\n");
  // Taking them all is the suggestion.
  assert.equal(taking(now, suggested, [0, 1, 2]).markdown, suggested);
});

test("a hunk says word by word what it takes out and puts in, in the document's positions", () => {
  const doc = markdownToPageDoc("# Relay\n\nPlanned for next week.\n");
  const [hunk] = pageDocHunks(doc, markdownToPageDoc("# Relay\n\nShipped this week.\n"));
  const out = hunk.changes.filter((change) => change.kind === "added").map((change) => doc.textBetween(change.from, change.to));
  const put = hunk.changes.filter((change) => change.kind === "removed").map((change) => change.text);
  assert.deepEqual(out, ["Planned for next"]);
  assert.deepEqual(put, ["Shipped this"]);
});

test("words put in at the end of a line keep the space that parts them from it", () => {
  const doc = markdownToPageDoc("The relay moves\n");
  const [hunk] = pageDocHunks(doc, markdownToPageDoc("The relay moves to the new region\n"));
  const put = hunk.changes.find((change) => change.kind === "removed");
  assert.equal(`${doc.textBetween(0, put.at)}${put.text}`, "The relay moves to the new region");
});

test("new blocks are put in between blocks, and removed ones are taken out whole", () => {
  const now = "# Plan\n\nOne\n\nTwo\n";
  assert.equal(taking(now, "# Plan\n\nOne\n\nOne and a half\n\nTwo\n", [0]).markdown,
    "# Plan\n\nOne\n\nOne and a half\n\nTwo\n");
  assert.equal(taking(now, "# Plan\n\nTwo\n", [0]).markdown, "# Plan\n\nTwo\n");
});

test("a document with nothing suggested has nothing to take", () => {
  const doc = markdownToPageDoc("# Plan\n\nShip it.\n");
  assert.deepEqual(pageDocHunks(doc, markdownToPageDoc("# Plan\n\nShip it.\n")), []);
});
