const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { commentBody, commentCall, commentTaker } = require("./page-comment.ts");

const AGENTS = ["claude", "codex"];
const CLAUDE = { name: "claude:3", conversationId: "co-writing", blockId: "intro" };
const CODEX = { name: "codex:1", conversationId: "review", blockId: "plan" };

test("a comment that mentions an Agent goes to it, at once", () => {
  assert.deepEqual(commentBody("@codex check the numbers", AGENTS, CLAUDE), { body: "@codex launch:force check the numbers" });
  assert.deepEqual(commentBody("shorter, @claude:2 please", AGENTS), { body: "shorter, @claude:2 launch:force please" });
});

test("one that names nobody goes to the Agent at work on the page, which is called to it in its own conversation", () => {
  assert.deepEqual(commentBody("make this shorter", AGENTS, CLAUDE), { body: "make this shorter", taker: CLAUDE });
  assert.equal(commentCall(CLAUDE, "discussion-1"), "@claude:3 A comment for you: channel:discussion-1");
});

test("with none at work there, xMatrix gives it to one", () => {
  assert.deepEqual(commentBody("make this shorter", AGENTS), { body: "@auto make this shorter" });
  assert.deepEqual(commentBody("ask @Yiming about it", AGENTS), { body: "@auto ask @Yiming about it" },
    "a person is not an Agent");
});

test("the taker is the Agent nearest the passage, among those the reader can write to", () => {
  const all = () => true;
  assert.equal(commentTaker([CLAUDE, CODEX], "plan", all), CODEX);
  assert.equal(commentTaker([CLAUDE, CODEX], "elsewhere", all), CLAUDE);
  assert.equal(commentTaker([CLAUDE, CODEX], "plan", (id) => id !== "review"), CLAUDE);
  assert.equal(commentTaker([], "plan", all), undefined);
});
