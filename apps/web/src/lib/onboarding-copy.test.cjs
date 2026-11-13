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
    const choice = copy.signedOutOrOff("Claude Code", "mac-mini");
    // The sign-in sentence, then the other answer and what it does.
    assert.ok(choice.startsWith(copy.signedOut("Claude Code", "mac-mini").replace(/[:：]$/u, "")), choice);
    const off = copy.turnedOff("Claude Code", "mac-mini") + copy.gap + copy.turnOnAgain.join("");
    assert.ok(off.includes("Claude Code") && off.includes("mac-mini") && off.includes("Agents"), off);
  }
  assert.equal(ONBOARDING_COPY.en.turnedOff("Claude Code", "mac-mini") + ONBOARDING_COPY.en.gap + ONBOARDING_COPY.en.turnOnAgain.join(""),
    "Claude Code on mac-mini is off in every Space, so nothing is sent to it. Turn it on again in Agents.");
  assert.equal(ONBOARDING_COPY.zh.signedOutOrOff("Claude Code", "mac-mini"),
    "mac-mini 上的 Claude Code 还没登录，登录之前接不了活。在这里登录；不用它就关掉，关掉后不会给它派活：");
});
