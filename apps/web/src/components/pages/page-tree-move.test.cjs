const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { pageDropAt, pageTreeAfterDrop } = require("./page-tree-move.ts");

const page = (pageId, position, parentPageId = null, canEdit = true) =>
  ({ pageId, parentPageId, position, canEdit });

const order = (pages, parent = null) => pages
  .filter((item) => item.parentPageId === parent)
  .sort((a, b) => a.position < b.position ? -1 : a.position > b.position ? 1 : a.pageId.localeCompare(b.pageId))
  .map((item) => item.pageId);

test("dropping on the bottom half of a page places the dragged page immediately after it", () => {
  const pages = [page("a", "V"), page("b", "W"), page("c", "X")];
  assert.deepEqual(pageDropAt(pages, "c", "a", "below"), { parentPageId: null, afterPageId: "a" });
  assert.deepEqual(order(pageTreeAfterDrop(pages, "c", pageDropAt(pages, "c", "a", "below"))), ["a", "c", "b"]);
});

test("dropping on the top half of the first page places the dragged page before it", () => {
  const pages = [page("a", "V"), page("b", "W"), page("c", "X")];
  assert.deepEqual(pageDropAt(pages, "c", "a", "above"), { parentPageId: null, beforePageId: "a" });
  assert.deepEqual(order(pageTreeAfterDrop(pages, "c", pageDropAt(pages, "c", "a", "above"))), ["c", "a", "b"]);
});

test("a page already in that place, one that cannot be edited, and a drop onto its own child do not move", () => {
  const pages = [page("a", "V"), page("b", "W"), page("child", "V", "a")];
  assert.equal(pageDropAt(pages, "b", "a", "below"), null);
  assert.equal(pageDropAt(pages, "a", "b", "above"), null);
  assert.equal(pageDropAt([page("a", "V", null, false), page("b", "W")], "a", "b", "below"), null);
  assert.equal(pageDropAt(pages, "a", "child", "below"), null);
});

test("dropping below a page under another keeps that parent and lands after the target", () => {
  const pages = [page("parent", "V"), page("a", "V", "parent"), page("b", "W", "parent"), page("c", "X", "parent")];
  const drop = pageDropAt(pages, "c", "a", "below");
  assert.deepEqual(drop, { parentPageId: "parent", afterPageId: "a" });
  assert.deepEqual(order(pageTreeAfterDrop(pages, "c", drop), "parent"), ["a", "c", "b"]);
});
