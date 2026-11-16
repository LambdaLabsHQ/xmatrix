const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { ONBOARDING_COPY } = require("./onboarding-copy.ts");

test("names read as a sentence in each language", () => {
  const { en, zh } = ONBOARDING_COPY;
  assert.equal(en.listNames(["Claude Code"]), "Claude Code");
  assert.equal(en.listNames(["Claude Code", "Codex"]), "Claude Code and Codex");
  assert.equal(en.listNames(["Claude Code", "Codex", "Gemini"]), "Claude Code, Codex and Gemini");
  assert.equal(zh.listNames(["Claude Code", "Codex", "Gemini"]), "Claude Code、Codex 和 Gemini");
});

test("an agent in is one line, and co-writing says the same in both languages", () => {
  const { en, zh } = ONBOARDING_COPY;
  assert.equal(en.agentsIn("@codex", true), "@codex is in. Mention it here to give it work.");
  assert.equal(zh.agentsIn("@codex", true), "@codex 已接入。在这里 @ 它就能派活。");
  assert.deepEqual(Object.keys(zh.coWrite).sort(), Object.keys(en.coWrite).sort());
});
