const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { COMPOSER_HINTS, composerHintAt } = require("./composer-hints.ts");
const { findActiveReference } = require("./reference-complete.ts");
const { findActiveSlashCommand } = require("./slash-complete.ts");

test("the empty composer cycles through every hint and wraps", () => {
  assert.deepEqual(COMPOSER_HINTS.map((_, step) => composerHintAt(step)), [...COMPOSER_HINTS]);
  assert.equal(composerHintAt(COMPOSER_HINTS.length), COMPOSER_HINTS[0]);
});

test("each hint names a trigger the composer completes", () => {
  const trigger = (hint) => hint.split(" ")[0];
  assert.deepEqual(COMPOSER_HINTS.map(trigger), ["@", "/", "[[", "#"]);
  assert.equal(findActiveReference("[[", 2)?.kind, "page");
  assert.equal(findActiveReference("#", 1)?.kind, "channel");
  assert.ok(findActiveSlashCommand("/", 1));
});

test("a rotating hint splits into its trigger and words; other placeholders do not", () => {
  const { composerHintParts } = require("./composer-hints.ts");
  assert.deepEqual(composerHintParts("@ to summon an agent"), { trigger: "@", rest: " to summon an agent" });
  assert.deepEqual(composerHintParts("[[ for pages"), { trigger: "[[", rest: " for pages" });
  assert.equal(composerHintParts("Join channel to send"), null);
});
