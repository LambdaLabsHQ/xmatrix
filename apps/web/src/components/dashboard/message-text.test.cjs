const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { normalizeMessageBodyForDisplay } = require("./message-text.ts");

test("agent messages render escaped paragraph breaks as real newlines", () => {
  assert.equal(
    normalizeMessageBodyForDisplay("Intro\\n\\n1. first\\n2. second", "agent"),
    "Intro\n\n1. first\n2. second"
  );
});

test("human messages preserve literal escaped newlines", () => {
  assert.equal(
    normalizeMessageBodyForDisplay("Use \\\\n in a string\\n\\nexample", "user"),
    "Use \\\\n in a string\\n\\nexample"
  );
});

test("agent messages keep single literal escape examples", () => {
  assert.equal(
    normalizeMessageBodyForDisplay("JavaScript strings can contain \\\\n.", "agent"),
    "JavaScript strings can contain \\\\n."
  );
});
