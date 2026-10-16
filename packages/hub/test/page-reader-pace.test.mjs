import assert from "node:assert/strict";
import test from "node:test";
import { readingMs, readingStep } from "../src/page-reader-pace.ts";

const pace = { charsPerSecond: 10, sentencePauseMs: 500 };

/** Text as a reader goes through it: each step shown at once, and how long until the next. */
function read(text) {
  const steps = [];
  for (let rest = text; rest;) {
    const step = readingStep(rest);
    rest = rest.slice(step.length);
    steps.push([step, readingMs(step, rest, pace)]);
  }
  return steps;
}

test("a reader takes a word at a time, with the punctuation and space after it, and a breath where a sentence or line ends", () => {
  assert.deepEqual(read("Shipped 1.0.508 today. Next:\n- review"), [
    ["Shipped ", 800], ["1.", 200], ["0.", 200], ["508 ", 400], ["today. ", 1200], ["Next:\n", 1100], ["- ", 200],
    ["review", 600],
  ], "a full stop inside a number goes on; one before a space, or a line's end, takes a breath");
  assert.deepEqual(read("**Done.** Then e.g. this"), [["**", 200], ["Done.** ", 1300], ["Then ", 500], ["e.", 200],
    ["g. ", 800], ["this", 400]]);
});

test("a Han character is a word and reads as two, and a full-width stop ends a sentence wherever it stands", () => {
  assert.deepEqual(read("好的。用Playwright测"), [["好", 200], ["的。", 800], ["用", 200], ["Playwright", 1000], ["测", 200]]);
  assert.equal(readingMs("done.", null, pace), 500, "a stop whose next words are not known yet is not taken for a sentence's end");
  assert.equal(readingMs("done.", "", pace), 1000, "where the text ends, it is one");
});
