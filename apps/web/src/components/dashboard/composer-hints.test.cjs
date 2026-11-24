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

// Every hint an empty composer shows works there (Daniel 2026-11-24).
test("a composer offers only the hints it completes", () => {
  const { composerHints } = require("./composer-hints.ts");
  assert.deepEqual(composerHints(), [...COMPOSER_HINTS]);
  // A new conversation, as the question box on a page: no Agents yet to take a command; channels at hand.
  assert.deepEqual(composerHints({ commands: false, channels: true }), ["@ to summon an agent", "[[ for pages", "# for channels"]);
  assert.deepEqual(composerHints({ commands: false, channels: false }), ["@ to summon an agent", "[[ for pages"]);
  assert.equal(composerHintAt(2, { commands: false, channels: false }), "@ to summon an agent");
});
