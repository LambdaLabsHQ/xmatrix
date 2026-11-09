"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { markAllDoneAction, NEEDS_YOU_SECTION_LABEL } = require("./needs-you-mark-all.ts");

const needsYou = { label: NEEDS_YOU_SECTION_LABEL, channels: [{ id: "a" }, { id: "b" }, { id: "c" }] };

test("Needs you marks every conversation in it done once the reader confirms", () => {
  const done = [];
  const asked = [];
  const action = markAllDoneAction(needsYou, (id) => done.push(id), (message) => { asked.push(message); return true; });
  assert.equal(action.label, "Mark all done");
  action.onClick();
  assert.deepEqual(asked, ["Mark 3 conversations done?"]);
  assert.deepEqual(done, ["a", "b", "c"]);
});

test("a declined confirmation marks nothing done", () => {
  const done = [];
  markAllDoneAction(needsYou, (id) => done.push(id), () => false).onClick();
  assert.deepEqual(done, []);
});

test("one conversation is asked about in the singular", () => {
  let asked;
  markAllDoneAction({ label: NEEDS_YOU_SECTION_LABEL, channels: [{ id: "a" }] }, () => {}, (message) => { asked = message; return false; })
    .onClick();
  assert.equal(asked, "Mark 1 conversation done?");
});

test("other sections, an empty Needs you, or a list that cannot mark done get no action", () => {
  assert.equal(markAllDoneAction({ label: "Pinned", channels: [{ id: "a" }] }, () => {}), undefined);
  assert.equal(markAllDoneAction({ label: NEEDS_YOU_SECTION_LABEL, channels: [] }, () => {}), undefined);
  assert.equal(markAllDoneAction(needsYou, undefined), undefined);
});
