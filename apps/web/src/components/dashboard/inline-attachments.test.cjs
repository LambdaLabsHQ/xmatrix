const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { draftPictures, insertPicturesIntoDraft, sentPictures } = require("./inline-attachments.ts");

test("pictures go on the line after the caret, or in place of an empty one, with a line to write on after", () => {
  const into = insertPicturesIntoDraft("Look", 4, [{ name: "a.png", ref: "r1" }, { name: "b [1].png", ref: "r2" }]);
  assert.equal(into.value, "Look\n![a.png](attachment:r1)\n![b \\[1\\].png](attachment:r2)\n");
  assert.equal(into.cursor, into.value.length);
  assert.deepEqual(draftPictures(into.value).map(({ name, ref }) => ({ name, ref })),
    [{ name: "a.png", ref: "r1" }, { name: "b [1].png", ref: "r2" }]);
  const between = insertPicturesIntoDraft("one\ntwo", 1, [{ name: "c.png", ref: "r3" }]);
  assert.equal(between.value, "one\n![c.png](attachment:r3)\ntwo");
  assert.equal(insertPicturesIntoDraft("", 0, [{ name: "d.png", ref: "r4" }]).value, "![d.png](attachment:r4)\n");
});

test("a sent draft names each picture by its place among the message's files, a row a paragraph of its own", () => {
  const places = new Map([["r1", 1], ["r2", 2]]);
  const body = "@codex look\n![a.png](attachment:r1)\n![b.png](attachment:r2)\n![gone.png](attachment:r9)\nwhy?\n";
  const sent = sentPictures({ body, selections: [{ start: 0, end: 6 }, { start: body.indexOf("why"), end: body.indexOf("why") + 3 }] },
    (ref) => places.get(ref));
  assert.equal(sent.body, "@codex look\n\n![a.png](attachment:1)\n![b.png](attachment:2)\n\nwhy?");
  assert.deepEqual(sent.selections.map(({ start, end }) => sent.body.slice(start, end)), ["@codex", "why"]);
  assert.equal(sentPictures({ body: "plain", selections: [] }, () => 1).body, "plain");
});

// The send boundary used to erase attachment-looking lines inside code. Rendering
// tests cannot catch it: the text was already lost before the message was stored.
test("literal attachment examples stay byte-for-byte inside fenced code, including unmatched and shorter fences", () => {
  const examples = [
    "```md\n![example.png](attachment:1)\n```",
    "~~~md\n![example.png](attachment:r1)\n~~~",
    "````md\n```\n![example.png](attachment:r1)\n````",
    "```md\n![example.png](attachment:missing)",
  ];
  for (const code of examples) {
    const body = `${code}\n`;
    assert.deepEqual(draftPictures(body), []);
    assert.equal(sentPictures({ body, selections: [] }, () => 1).body, code);
  }
  const body = `${examples[0]}\n![real.png](attachment:r1)\nEnd`;
  assert.deepEqual(draftPictures(body).map(({ ref }) => ref), ["r1"]);
  assert.equal(sentPictures({ body, selections: [] }, (ref) => ref === "r1" ? 2 : undefined).body,
    `${examples[0]}\n\n![real.png](attachment:2)\n\nEnd`);
});

// Only an actual Markdown image may be rewritten as an uploaded picture. These
// contexts span lines, so a fence-only scan cannot protect their literal source.
test("inline code and HTML retain attachment-looking source when sending, with or without a matching upload", () => {
  for (const body of [
    "`example\n![example.png](attachment:r1)\nend`",
    "``example\n![example.png](attachment:r1)\nend``",
    "<!--\n![example.png](attachment:r1)\n-->",
    "<div>\n![example.png](attachment:r1)\n</div>",
  ]) {
    assert.deepEqual(draftPictures(body), []);
    for (const place of [undefined, 2]) {
      assert.equal(sentPictures({ body, selections: [] }, () => place).body, body);
    }
  }
  const body = "`example\n![example.png](attachment:r1)\nend`\n![real.png](attachment:r2)\nwhy?";
  assert.deepEqual(draftPictures(body).map(({ ref }) => ref), ["r2"]);
  const start = body.indexOf("why?");
  const sent = sentPictures({ body, selections: [{ start, end: start + 4 }] }, () => 1);
  assert.equal(sent.body, "`example\n![example.png](attachment:r1)\nend`\n\n![real.png](attachment:1)\n\nwhy?");
  assert.deepEqual(sent.selections.map(({ start, end }) => sent.body.slice(start, end)), ["why?"]);
});
