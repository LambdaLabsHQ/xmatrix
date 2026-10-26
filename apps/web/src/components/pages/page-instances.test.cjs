const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { instanceCall, pageInstances } = require("./page-instances.ts");

const CLAUDE = { instanceId: "i-claude", name: "claude:2", harness: "claude", conversationId: "co-writing", section: "Plan" };
const CODEX = { instanceId: "i-codex", name: "codex:1", conversationId: "review" };
const all = () => true;

test("an `@` offers the live Instances in this page's conversations, each once", () => {
  assert.deepEqual(pageInstances([CLAUDE, CODEX, CLAUDE], all), [
    { name: "claude:2", harness: "claude", conversationId: "co-writing", where: "Plan" },
    { name: "codex:1", harness: "codex", conversationId: "review", where: "This page" },
  ]);
});

test("only an Instance whose conversation the reader can write in, since it is told there", () => {
  assert.deepEqual(pageInstances([CLAUDE, CODEX], (id) => id !== "co-writing").map((item) => item.name), ["codex:1"]);
});

test("it is called by name, with where the `@` was made", () => {
  assert.equal(instanceCall(CLAUDE, "page:p1#plan"), "@claude:2 page:p1#plan");
});
