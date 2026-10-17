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

test("Chinese starters are the same first tasks, each ending in a page", () => {
  const { en, zh } = ONBOARDING_COPY;
  assert.deepEqual(zh.starters.map((starter) => starter.id), en.starters.map((starter) => starter.id));
  for (const starter of zh.starters) assert.match(starter.message, /页面/u, starter.id);
  assert.match(zh.starters.find((starter) => starter.id === "xmatrix").message, /https:\/\/xmatrix\.sh\/start\.md/u);
});
