const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { pageFindFirstFrom, pageFindMatches, pageFindStep } = require("./page-find-model.ts");

test("find in page ignores case and stops at a block's edge", () => {
  const text = "Pages hold the plan\nthe plan changes";
  assert.deepEqual(pageFindMatches(text, "PLAN"), [[15, 19], [24, 28]]);
  assert.deepEqual(pageFindMatches(text, "plan the"), []);
  assert.deepEqual(pageFindMatches(text, "  "), []);
});

test("a run of spaces matches any run, and symbols are found as typed", () => {
  assert.deepEqual(pageFindMatches("keep  sessions 30 days (or 7)", "keep sessions"), [[0, 14]]);
  assert.deepEqual(pageFindMatches("costs $5.00 (or 7)", "(or 7)"), [[12, 18]]);
  assert.deepEqual(pageFindMatches("搜索本页面，在本页面搜索", "本页面"), [[2, 5], [7, 10]]);
});

test("the first match shown is at or below the reader's place, and steps go round the ends", () => {
  assert.equal(pageFindFirstFrom([-200, -10, 40, 900], 0), 2);
  assert.equal(pageFindFirstFrom([-200, -10], 0), 0);
  assert.equal(pageFindStep(2, 3, 1), 0);
  assert.equal(pageFindStep(0, 3, -1), 2);
  assert.equal(pageFindStep(0, 0, 1), 0);
});
