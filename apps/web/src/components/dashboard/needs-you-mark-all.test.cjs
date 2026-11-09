"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { markAllDoneAction, NEEDS_YOU_SECTION_LABEL } = require("./needs-you-mark-all.ts");

const needsYou = { label: NEEDS_YOU_SECTION_LABEL, channels: [{ id: "a" }, { id: "b" }, { id: "c" }] };

test("the first tap only arms Mark all done; it marks nothing and asks in its place", () => {
  const done = [];
  const armedTo = [];
  const action = markAllDoneAction(needsYou, (id) => done.push(id), false, (armed) => armedTo.push(armed));
  assert.equal(action.label, "Mark all done");
  action.onClick();
  assert.deepEqual(armedTo, [true]);
  assert.deepEqual(done, []);
});

test("the confirming tap marks every conversation in Needs you done and disarms", () => {
  const done = [];
  const armedTo = [];
  const action = markAllDoneAction(needsYou, (id) => done.push(id), true, (armed) => armedTo.push(armed));
  assert.equal(action.label, "Mark 3 done?");
  action.onClick();
  assert.deepEqual(armedTo, [false]);
  assert.deepEqual(done, ["a", "b", "c"]);
});

test("the confirmation is the list's own, never window.confirm", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "needs-you-mark-all.ts"), "utf8");
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ""), /window\.confirm/);
});

test("other sections, an empty Needs you, or a list that cannot mark done get no action", () => {
  assert.equal(markAllDoneAction({ label: "Pinned", channels: [{ id: "a" }] }, () => {}, false, () => {}), undefined);
  assert.equal(markAllDoneAction({ label: NEEDS_YOU_SECTION_LABEL, channels: [] }, () => {}, false, () => {}), undefined);
  assert.equal(markAllDoneAction(needsYou, undefined, true, () => {}), undefined);
});
