const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { instanceCall, instanceMention, pageInstances } = require("./page-instances.ts");

const CLAUDE = { instanceId: "i-claude", name: "claude:2", harness: "claude", conversationId: "co-writing", status: "busy" };
const CODEX = { instanceId: "i-codex", name: "codex:1", conversationId: "review", status: "idle" };
const NAMES = { "co-writing": "Plan the trip", review: "Review" };
const all = (id) => NAMES[id] ?? null;

test("an `@` offers the live Instances in this page's conversations, each once, with whether it is free", () => {
  assert.deepEqual(pageInstances([CLAUDE, CODEX, CLAUDE], all), [
    { name: "claude:2", harness: "claude", conversationId: "co-writing", conversation: "Plan the trip", status: "busy" },
    { name: "codex:1", harness: "codex", conversationId: "review", conversation: "Review", status: "idle" },
  ]);
});

test("only an Instance whose conversation the reader can write in, since it is told there", () => {
  assert.deepEqual(pageInstances([CLAUDE, CODEX], (id) => id === "co-writing" ? null : all(id)).map((item) => item.name), ["codex:1"]);
});

test("it is called by name, with where the `@` was made", () => {
  assert.equal(instanceCall(CLAUDE, "page:p1#plan"), "@claude:2 page:p1#plan");
});

test("the page keeps which conversation's Instance an `@` called, since Instance names repeat across conversations", () => {
  assert.equal(instanceMention({ name: "grok:1", conversationId: "D373342D-7E28-8743-F7A6-F1D0BF37B83B" }),
    "@grok:1 channel:d373342d-7e28-8743-f7a6-f1d0bf37b83b");
});
