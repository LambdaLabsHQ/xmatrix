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

test("a program that is not signed in gives its owner two answers, and one turned off says where it turns on again", () => {
  for (const copy of Object.values(ONBOARDING_COPY)) {
    const off = copy.turnedOff("Claude Code", "mac-mini") + copy.gap + copy.turnOnAgain.join("");
    assert.ok(off.includes("Claude Code") && off.includes("mac-mini") && off.includes("Agents"), off);
  }
  assert.equal(ONBOARDING_COPY.en.turnedOff("Claude Code", "mac-mini") + ONBOARDING_COPY.en.gap + ONBOARDING_COPY.en.turnOnAgain.join(""),
    "Claude Code on mac-mini is disabled in every Space. Turn it on again in Agents.");
  // The second button names what it disables; the card adds no sentence explaining it.
  assert.equal(ONBOARDING_COPY.en.turnOff("Claude Code"), "Disable Claude Code");
  assert.equal(ONBOARDING_COPY.zh.turnOff("Claude Code"), "禁用 Claude Code");
});
