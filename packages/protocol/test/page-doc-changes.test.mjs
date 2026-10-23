import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToPageDoc, pageDocChanges, pageDocToMarkdown, pageSeenDoc } from "../dist/page-document.js";

/** The changes as text a reader would see: what is new, and what was taken out. */
function described(before, after) {
  const doc = markdownToPageDoc(after);
  return pageDocChanges(markdownToPageDoc(before), doc).map((change) => change.kind === "added"
    ? `+${change.block ? "block " : ""}${doc.textBetween(change.from, change.to, "|")}`
    : `-${change.block ? "block " : ""}${change.text}@${doc.textBetween(Math.max(0, change.at - 4), change.at)}`);
}

test("the same document has no changes", () => {
  assert.deepEqual(described("# Plan\n\nShip it.\n", "# Plan\n\nShip it.\n"), []);
});

test("words written into a paragraph are new; the rest of it is not", () => {
  assert.deepEqual(described("# Plan\n\nShip the relay.\n", "# Plan\n\nShip the new relay today.\n"),
    ["+new", "+today"]);
});

test("a replaced word is new, and what it replaced was taken out where it stood", () => {
  assert.deepEqual(described("Status: next\n", "Status: shipped\n"), ["+shipped", "-next@us: "]);
});

test("Chinese text changes word by word, not as one whole run", () => {
  assert.deepEqual(described("状态：进行中\n", "状态：已完成\n"), ["+已完成", "-进行中@状态："]);
  assert.deepEqual(described("状态：进行中，下周发布\n", "状态：进行中，明天发布\n"), ["+明天", "-下周@进行中，"]);
});

test("a new section is new as blocks; a removed one is taken out between blocks", () => {
  assert.deepEqual(described("# Plan\n\nOne\n", "# Plan\n\nOne\n\n## Risks\n\nLate\n"), ["+block Risks", "+block Late"]);
  assert.deepEqual(described("# Plan\n\nOne\n\nTwo\n", "# Plan\n\nTwo\n"), ["-block One@lan"]);
});

test("a word made bold is new, and is not also taken out", () => {
  assert.deepEqual(described("Ship it now\n", "Ship **it** now\n"), ["+it"]);
});

test("a paragraph that became a list item shows as a new block", () => {
  assert.deepEqual(described("Ship it\n", "- Ship it\n"), ["+block Ship it"]);
});

test("a ticked task shows as changed", () => {
  assert.deepEqual(described("- [ ] Ship it\n", "- [x] Ship it\n"), ["+block Ship it"]);
});

test("a rewritten page stays bounded", () => {
  const before = Array.from({ length: 800 }, (_, index) => `Line ${index} old`).join("\n\n");
  const after = Array.from({ length: 800 }, (_, index) => `Line ${index} new`).join("\n\n");
  const changes = pageDocChanges(markdownToPageDoc(before), markdownToPageDoc(after));
  assert.ok(changes.length > 0 && changes.length <= 300);
});

test("a rewritten phrase is one change, not word by word around the spaces it kept", () => {
  assert.deepEqual(described("Planned for next week\n", "Shipped this week\n"), ["+Shipped this", "-Planned for next@"]);
});

test("text taken out of a line reads as it did, drawn back in where it was", () => {
  // The document's text with each piece taken out back in its place, in brackets.
  const reread = (before, after) => {
    const doc = markdownToPageDoc(after);
    let text = "";
    let from = 0;
    for (const change of pageDocChanges(markdownToPageDoc(before), doc)) {
      if (change.kind !== "removed") continue;
      text += `${doc.textBetween(from, change.at)}[${change.text}]`;
      from = change.at;
    }
    return text + doc.textBetween(from, doc.content.size);
  };
  assert.equal(reread("Ship it now\n", "Ship it\n"), "Ship it[ now]");
  assert.equal(reread("Ship the relay now\n", "Ship now\n").replace(/[[\]]/gu, ""), "Ship the relay now");
  assert.equal(reread("Status: next\n", "Status: shipped\n"), "Status: [next]shipped");
});

/** What the reader has seen of `after`, having seen `before`, when the blocks holding `visible` were on screen. */
function seenOf(before, after, visible) {
  const doc = markdownToPageDoc(after);
  const inView = (pos, end) => visible.some((text) => doc.textBetween(pos, end, "\n").includes(text));
  return pageDocToMarkdown(pageSeenDoc(markdownToPageDoc(before), doc, inView));
}

test("a reader has seen what was on screen as it is now, and what was not as they last saw it", () => {
  const before = "# Plan\n\nGoal: ten users\n\nOld channel\n\nNotes\n";
  const after = "# Plan\n\nGoal: a hundred users\n\nNew paragraph\n\nNotes\n\nMetrics later\n";
  // Seen at the top only: the goal is read, the rest below waits as it was.
  assert.equal(seenOf(before, after, ["Plan", "Goal"]), "# Plan\n\nGoal: a hundred users\n\nOld channel\n\nNotes\n");
  // All of it seen, it is the page as it is.
  assert.equal(seenOf(before, after, ["Plan", "Goal", "New", "Notes", "Metrics"]), after);
  // Nothing seen, nothing is read.
  assert.equal(seenOf(before, after, []), before);
});

test("a block taken out is gone for the reader once where it stood was on screen", () => {
  const before = "Intro\n\nGone soon\n\nOutro\n";
  assert.equal(seenOf(before, "Intro\n\nOutro\n", ["Outro"]), "Intro\n\nOutro\n");
  assert.equal(seenOf(before, "Intro\n\nOutro\n", []), before);
  // A new block seen in the place of one taken out reads as replacing it.
  assert.equal(seenOf(before, "Intro\n\nArrived\n\nOutro\n", ["Arrived"]), "Intro\n\nArrived\n\nOutro\n");
});
