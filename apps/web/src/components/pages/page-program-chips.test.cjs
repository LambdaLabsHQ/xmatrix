const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { problemRange, programBlockName, programFooter, programStep } = require("./page-program-chips.ts");

const NOW = Date.parse("2026-11-12T10:00:00Z");
const request = (change) => ({ holder: "@codex", text: "Review the design", askedAt: "2026-11-12T09:50:00Z", by: null, outcome: null,
  reply: null, settledAt: null, ...change });

test("a norn run block names its program, and any other block names none", () => {
  assert.deepEqual(["norn run", "norn run review", "norn", "norn run two words", "ts"].map(programBlockName),
    ["main", "review", null, null, null]);
});

test("a request is a step: working with the time it has left, its answer, or how it failed", () => {
  assert.deepEqual(programStep(request({ by: "2026-11-12T10:24:00Z" }), NOW),
    { state: "working", holder: "@codex", text: "Review the design", note: "working · 24 min left" });
  assert.equal(programStep(request({}), NOW).note, "working");
  assert.deepEqual([programStep(request({ outcome: "answered", reply: "Flawed(no owner)" }), NOW)].map(step => [step.state, step.note]),
    [["answered", "Flawed(no owner)"]]);
  assert.deepEqual([request({ outcome: "broke", reply: "its turn ended" }), request({ outcome: "no_reply" })]
    .map(each => programStep(each, NOW)).map(step => [step.state, step.note]),
    [["failed", "could not · its turn ended"], ["failed", "no reply"]]);
});

test("below its steps a program says how it ended, or why it does not run; while a step works it says nothing more", () => {
  const program = (change) => ({ name: "main", state: "running", requests: [], ...change });
  assert.deepEqual(programFooter(undefined), { state: "starting", text: "starting…" });
  assert.equal(programFooter(program({ requests: [request({})] })), null);
  assert.deepEqual(programFooter(program({})), { state: "running", text: "running" });
  assert.deepEqual(programFooter(program({ state: "completed", result: "sound" })), { state: "finished", text: "sound" });
  assert.deepEqual(programFooter(program({ state: "failed", result: "Removed from its page" })), { state: "stopped", text: "Removed from its page" });
  assert.deepEqual(programFooter(program({ state: "not_started", problem: "2:3 unknown name foo\nmore" })), { state: "problem", text: "unknown name foo" });
});

test("a problem that names its place marks that word in the code", () => {
  assert.deepEqual(problemRange("let x = 1\n  foo(x)", "2:3 unknown name foo"), { from: 12, to: 15 });
  assert.equal(problemRange("let x = 1", "Two blocks are named main; rename one."), null);
  assert.equal(problemRange("let x = 1", "9:1 beyond the text"), null);
});
