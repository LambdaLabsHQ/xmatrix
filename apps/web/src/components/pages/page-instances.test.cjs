const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { instanceCall, pageInstances } = require("./page-instances.ts");

const CLAUDE = { instanceId: "i-claude", name: "claude:2", harness: "claude", conversationId: "co-writing", section: "Plan" };
const CODEX = { instanceId: "i-codex", name: "codex:1", conversationId: "review" };
const titles = { other: "Roadmap" };
const title = (id) => titles[id] ?? null;
const all = () => true;

test("an `@` offers the live Instances at work on the Space's pages, those on this page first, each once", () => {
  const byPage = new Map([["other", [CODEX, CLAUDE]], ["here", [CLAUDE]]]);
  assert.deepEqual(pageInstances(byPage, "here", title, all), [
    { name: "claude:2", harness: "claude", conversationId: "co-writing", where: "Plan" },
    { name: "codex:1", harness: "codex", conversationId: "review", where: "Roadmap" },
  ]);
});

test("only an Instance whose conversation the reader can write in, since it is told there", () => {
  const byPage = new Map([["here", [CLAUDE, CODEX]]]);
  assert.deepEqual(pageInstances(byPage, "here", title, (id) => id !== "co-writing").map((item) => item.name), ["codex:1"]);
  assert.equal(pageInstances(byPage, "here", title, all)[1].where, "This page");
});

test("it is called by name, with where the `@` was made", () => {
  assert.equal(instanceCall(CLAUDE, "page:p1#plan"), "@claude:2 page:p1#plan");
});
