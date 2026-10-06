import assert from "node:assert/strict";
import test from "node:test";

import { duplicateCssRules } from "./check-css-duplicate-rules.mjs";

const at = (text) => duplicateCssRules(text).map((rule) => rule.line);

test("an identical earlier rule is reported, the later copy is kept", () => {
  const text = [
    ".glass {", // line 1
    "  background: red;",
    "}",
    "",
    ".glass {", // line 5
    "  background: red;",
    "}",
  ].join("\n");
  assert.deepEqual(at(text), [1]);
});

test("a re-declaration with different declarations is an override, not noise", () => {
  const text = [".glass { background: red; }", ".glass { background: blue; }"].join("\n");
  assert.deepEqual(at(text), []);
});

test("the same rule under a different at-rule context is a different rule", () => {
  const text = [
    "@media (min-width: 768px) {",
    "  .glass { background: red; }",
    "}",
    "@media (max-width: 767px) {",
    "  .glass { background: red; }",
    "}",
  ].join("\n");
  assert.deepEqual(at(text), []);
});

test("comments do not hide a duplicate, and line numbers stay the file's", () => {
  const text = [
    "/* a comment",
    "   spanning lines */",
    ".glass { background: red; }", // line 3
    "/* another",
    "   comment */",
    ".glass { background: red; }", // line 6
  ].join("\n");
  assert.deepEqual(at(text), [3]);
});
