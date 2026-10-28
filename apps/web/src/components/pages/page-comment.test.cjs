const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { commentBody, commentTaker } = require("./page-comment.ts");

const AGENTS = ["claude", "codex"];
const CLAUDE = { name: "claude:3", conversationId: "co-writing", blockId: "intro" };
const CODEX = { name: "codex:1", conversationId: "review", blockId: "plan" };

test("a comment that mentions an Agent goes to it, at once", () => {
  assert.deepEqual(commentBody("@codex check the numbers", AGENTS, CLAUDE), { body: "@codex launch:force check the numbers" });
  assert.deepEqual(commentBody("shorter, @claude:2 please", AGENTS), { body: "shorter, @claude:2 launch:force please" });
});

test("one that names nobody addresses the existing Instance in its own conversation", () => {
  assert.deepEqual(commentBody("make this shorter", AGENTS, CLAUDE), { body: "@claude:3 make this shorter", taker: CLAUDE });
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

test("a live Instance the comment names takes it in its own conversation, rather than a new one starting", () => {
  assert.deepEqual(commentBody("@Claude:3 shorter", AGENTS, CODEX, [CLAUDE, CODEX]), { body: "@claude:3 shorter", taker: CLAUDE });
  assert.deepEqual(commentBody("@claude:2 shorter", AGENTS, CODEX, [CLAUDE]), { body: "@claude:2 launch:force shorter" },
    "one not live starts as before");
});

test("a bare Agent mention continues the selected live Instance, including repeated names across conversations", () => {
  const other = { ...CLAUDE, conversationId: "elsewhere" };
  assert.deepEqual(commentBody("shorter, @claude please", AGENTS, CLAUDE, [other, CLAUDE]),
    { body: "shorter, @claude:3 please", taker: CLAUDE });
});

test("without a live Instance the section's editing conversation keeps the comment unless another Agent is requested", () => {
  assert.deepEqual(commentBody("make this shorter", AGENTS, undefined, [], "editing"),
    { body: "make this shorter", conversationId: "editing" });
  assert.deepEqual(commentBody("@codex check", AGENTS, undefined, [], "editing"),
    { body: "@codex launch:force check" });
});
