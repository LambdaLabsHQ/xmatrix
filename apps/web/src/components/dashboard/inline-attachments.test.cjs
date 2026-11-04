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
