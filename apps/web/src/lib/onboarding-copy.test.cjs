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

test("the welcome's cards say the same in both languages", () => {
  const { en, zh } = ONBOARDING_COPY;
  for (const card of ["talk", "together", "coWrite", "machines"]) {
    assert.deepEqual(Object.keys(zh[card]).sort(), Object.keys(en[card]).sort(), card);
  }
  assert.equal(zh.together.draft("claude", "codex").startsWith("@claude @codex "), true);
  assert.equal(en.together.draft("claude", "codex").startsWith("@claude @codex "), true);
});
