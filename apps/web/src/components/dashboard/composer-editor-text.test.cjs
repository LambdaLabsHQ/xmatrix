const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { composerDocFromText, composerOffsetOf, composerPosOf, composerTextOf } = require("./composer-editor-text.ts");

test("a draft and its document round-trip, blank lines included", () => {
  for (const text of ["", "hello", "a\nb", "\n", "@codex\n\n看一下\n"]) {
    assert.equal(composerTextOf(composerDocFromText(text)), text);
  }
});

test("every draft offset maps to a document position and back", () => {
  const text = "ab\n\ncd";
  const doc = composerDocFromText(text);
  for (let offset = 0; offset <= text.length; offset += 1) {
    assert.equal(composerOffsetOf(doc, composerPosOf(doc, offset)), offset);
  }
  // Each line's boundaries sit between its paragraphs: `cd` starts after two of them.
  assert.equal(composerPosOf(doc, 0), 1);
  assert.equal(composerPosOf(doc, 3), 5);
  assert.equal(composerPosOf(doc, 4), 7);
  // Past the end clamps to the end.
  assert.equal(composerOffsetOf(doc, composerPosOf(doc, 99)), text.length);
});
