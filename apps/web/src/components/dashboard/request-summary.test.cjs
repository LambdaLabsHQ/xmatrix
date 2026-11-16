const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { requestSummary } = require("./request-summary.ts");

test("a short request is its own summary", () => {
  assert.equal(requestSummary("Audit the day's merges"), "Audit the day's merges");
});

test("a request with more lines says there is more", () => {
  assert.equal(requestSummary("Audit the day's merges\nand the changelog"), "Audit the day's merges …");
});

test("a long paragraph stops at its first sentence", () => {
  const asked = "按「搜索与候选」做每周供应商池维护。榜单在管理页（独立持久化）：先读最新快照与 revision，不从 Page 读逐站名单；主任务是逐家复查池内所有站点和待办，未完成覆盖前不优先找新站。";
  assert.equal(requestSummary(asked), "按「搜索与候选」做每周供应商池维护。 …");
});

test("a sentence too long for a chip is cut between words, never inside one", () => {
  const asked = "Review every provider in the pool against the retained evidence and the published prices before looking for any new candidate at all";
  const summary = requestSummary(asked);
  assert.equal(summary, "Review every provider in the pool against the retained evidence and the …");
  assert.ok(asked.startsWith(summary.slice(0, -2)));
});

test("unbroken text is cut at the budget", () => {
  assert.equal(requestSummary("x".repeat(200)), `${"x".repeat(72)} …`);
});
