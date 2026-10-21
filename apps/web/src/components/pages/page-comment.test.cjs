const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { commentBody } = require("./page-comment.ts");

const AGENTS = ["claude", "codex"];

test("a comment that mentions an Agent goes to it, at once", () => {
  assert.equal(commentBody("@codex check the numbers", AGENTS, ["Claude"]), "@codex launch:force check the numbers");
  assert.equal(commentBody("shorter, @claude:2 please", AGENTS), "shorter, @claude:2 launch:force please");
});

test("one that names nobody goes to the kind of Agent at work on the page, nearest first", () => {
  assert.equal(commentBody("make this shorter", AGENTS, ["Codex:1", "Claude"]), "@codex launch:force make this shorter");
  assert.equal(commentBody("make this shorter", AGENTS, ["Grok", "claude"]), "@claude launch:force make this shorter",
    "an Agent this reader cannot call is passed over");
});

test("with none at work there, xMatrix gives it to one", () => {
  assert.equal(commentBody("make this shorter", AGENTS), "@auto make this shorter");
  assert.equal(commentBody("ask @Yiming about it", AGENTS), "@auto ask @Yiming about it", "a person is not an Agent");
});
