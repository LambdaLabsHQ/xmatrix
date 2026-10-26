const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { heldPageMessageEdits } = require("./page-message-edits-hold.ts");

const edit = (messageId, pageId = "page:one") => ({ messageId, pageId, title: "Page", revisions: [{ revision: 2 }] });

test("a new read keeps the cards of messages still on screen", () => {
  const previous = { edits: [edit("m1"), edit("m2"), edit("m3", "page:two")] };
  assert.deepEqual(heldPageMessageEdits(previous, ["m2", "m3", "m4"]), { edits: [edit("m2"), edit("m3", "page:two")] });
});

test("nothing is held when no message from the last read is still asked about", () => {
  assert.equal(heldPageMessageEdits({ edits: [edit("m1")] }, ["m9"]), undefined);
  assert.equal(heldPageMessageEdits({ edits: [] }, ["m1"]), undefined);
  assert.equal(heldPageMessageEdits(undefined, ["m1"]), undefined);
});
