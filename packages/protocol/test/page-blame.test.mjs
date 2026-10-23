import assert from "node:assert/strict";
import { test } from "node:test";
import { carryPageDocKnown, markdownToPageDoc, markdownToPageDocSources, pageBlameFirst, pageBlameOrigins,
  pageBlameStep } from "../dist/page-document.js";

/** Each revision's text in `body`, as `[text, revision]` pieces. */
function pieces(body, runs) {
  const out = [];
  let at = 0;
  for (let index = 0; index < runs.length; index += 2) {
    out.push([body.slice(at, at + runs[index]), runs[index + 1]]);
    at += runs[index];
  }
  return out;
}

test("a page's first revision wrote all of it", () => {
  assert.deepEqual(pageBlameFirst("# A\n\nText\n", 1), [10, 1]);
  assert.deepEqual(pageBlameFirst("", 1), []);
});

test("lines that did not change keep their revision; a new line is the new revision's", () => {
  const one = "# Plan\n\nShip it.\n";
  const two = "# Plan\n\nShip it.\n\nThen measure.\n";
  assert.deepEqual(pieces(two, pageBlameStep(one, pageBlameFirst(one, 1), two, 2)),
    [["# Plan\n\nShip it.\n", 1], ["\nThen measure.\n", 2]]);
});

test("in a changed line, the words that stayed keep their writer", () => {
  const one = "We ship on Friday.\n";
  const two = "We ship on Monday.\n";
  assert.deepEqual(pieces(two, pageBlameStep(one, pageBlameFirst(one, 1), two, 2)),
    [["We ship on ", 1], ["Monday", 2], [".\n", 1]]);
});

test("Chinese is blamed by the character", () => {
  const one = "不发邮件设置链接。\n";
  const two = "不发邮件链接。\n";
  const three = "不发邮件登录链接。\n";
  const second = pageBlameStep(one, pageBlameFirst(one, 1), two, 2);
  assert.deepEqual(pieces(two, second), [["不发邮件链接。\n", 1]]);
  assert.deepEqual(pieces(three, pageBlameStep(two, second, three, 3)), [["不发邮件", 1], ["登录", 3], ["链接。\n", 1]]);
});

test("making words bold leaves them with whoever wrote them", () => {
  const one = "Keep sessions for 30 days.\n";
  const two = "Keep sessions for **30 days**.\n";
  assert.deepEqual(pieces(two, pageBlameStep(one, pageBlameFirst(one, 1), two, 2)),
    [["Keep sessions for ", 1], ["**", 2], ["30 days", 1], ["**", 2], [".\n", 1]]);
});

test("blame carries across many revisions, and removed text takes its revision with it", () => {
  const bodies = ["A b c\n", "A b c d\n", "A c d\n", "Z\nA c d\n"];
  let runs = pageBlameFirst(bodies[0], 1);
  for (let index = 1; index < bodies.length; index++) runs = pageBlameStep(bodies[index - 1], runs, bodies[index], index + 1);
  assert.deepEqual(pieces(bodies[3], runs), [["Z\n", 4], ["A c", 1], [" d", 2], ["\n", 1]]);
});

test("origins fill what the runs do not cover", () => {
  assert.deepEqual([...pageBlameOrigins([2, 1], 4, 9)], [1, 1, 9, 9]);
});

test("every character of the document maps to where it stands in the markdown", () => {
  const markdown = "# Title\n\nSome **bold** and `code` and [a link](https://x.y) \\*escaped\\*.\n\n- [ ] task\n\n```ts\nconst a = 1;\n```\n";
  const { doc, sources } = markdownToPageDocSources(markdown);
  assert.equal(doc.eq(markdownToPageDoc(markdown)), true);
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (let at = 0; at < node.text.length; at++) {
      const char = node.text[at];
      assert.equal(markdown[sources[pos + at]], char, `${JSON.stringify(node.text)}[${at}]`);
    }
    return true;
  });
});

test("what is known about a document carries to the same text in the next one", () => {
  const before = markdownToPageDoc("# T\n\nOne two three.\n\nKept.\n");
  const after = markdownToPageDoc("# T\n\nOne 2 three.\n\nNew.\n\nKept.\n");
  const known = new Int32Array(before.content.size + 1).fill(-1);
  before.descendants((node, pos) => {
    if (node.isText) for (let at = 0; at < node.text.length; at++) known[pos + at] = 7;
    return true;
  });
  const carried = carryPageDocKnown(before, known, after);
  const read = () => {
    let out = "";
    after.descendants((node, pos) => {
      if (node.isText) for (let at = 0; at < node.text.length; at++) out += carried[pos + at] === 7 ? node.text[at] : "_";
      else if (node.isBlock && out) out += "|";
      return true;
    });
    return out;
  };
  assert.equal(read(), "T|One _ three.|____|Kept.");
});
