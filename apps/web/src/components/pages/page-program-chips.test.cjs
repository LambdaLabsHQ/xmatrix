const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { problemRange, programBlockName } = require("./page-program-chips.ts");
const { againText, conditionsText, endText, programFooter, programStep, waitText } = require("./program-flow.ts");

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
  const program = (change) => ({ name: "main", state: "running", requests: [], next: [], ...change });
  assert.deepEqual(programFooter(undefined), { state: "starting", text: "starting…" });
  assert.equal(programFooter(program({ requests: [request({})] })), null);
  assert.deepEqual(programFooter(program({})), { state: "running", text: "running" });
  // What it waits for now is the first step of its flow, which says so itself.
  assert.equal(programFooter(program({ next: [{ kind: "wait", at: "2026-11-17T02:00:00Z", on: [], repeats: false, every: null }] })), null);
  assert.deepEqual(programFooter(program({ state: "completed", result: "sound" })), { state: "finished", text: "sound" });
  assert.deepEqual(programFooter(program({ state: "failed", result: "Removed from its page" })), { state: "stopped", text: "Removed from its page" });
  assert.deepEqual(programFooter(program({ state: "not_started", problem: "2:3 unknown name foo\nmore" })), { state: "problem", text: "unknown name foo" });
});

test("a problem that names its place marks that word in the code", () => {
  assert.deepEqual(problemRange("let x = 1\n  foo(x)", "2:3 unknown name foo"), { from: 12, to: 15 });
  assert.equal(problemRange("let x = 1", "Two blocks are named main; rename one."), null);
  assert.equal(problemRange("let x = 1", "9:1 beyond the text"), null);
});

test("a step of the flow reads as what the program does: when, under what, how it ends and where it goes back to", () => {
  const time = (at) => at.slice(0, 16);
  const wait = (change) => ({ kind: "wait", at: null, on: [], repeats: false, every: null, ...change });
  assert.deepEqual(waitText(wait({ at: "2026-11-17T02:00:00Z" }), time), { title: "2026-11-17T02:00", detail: "" });
  assert.deepEqual(waitText(wait({ at: "2026-11-14T09:00:00Z", repeats: true, every: 86_400_000, on: ["CI fails on acme/app"] }), time),
    { title: "Every 1 d, and when CI fails on acme/app", detail: "next 2026-11-14T09:00" });
  assert.deepEqual(waitText(wait({ repeats: true, on: ["CI fails on acme/app"] }), time), { title: "Each time CI fails on acme/app", detail: "" });
  assert.deepEqual(waitText(wait({ on: ["a pull request merges on acme/app"] }), time), { title: "When a pull request merges on acme/app", detail: "" });
  assert.equal(conditionsText({ repo: "acme/app", effort: "high" }), "acme/app · effort high");
  assert.deepEqual([{ failed: false, result: "the answer" }, { failed: false, result: "" }, { failed: true, result: "" }]
    .map(each => endText({ kind: "end", ...each })), ["Ends with the answer", "Ends", "Stops without a result"]);
  assert.deepEqual([null, "Find what does not hold\nin the draft"].map(text => againText({ kind: "again", text })),
    ["Next round", "Back to “Find what does not hold”"]);
});
