const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { automaticConversationName } = require("./start-conversation.ts");

test("a new conversation is named from the first line of what should happen", () => {
  assert.equal(automaticConversationName("@auto fix the **flaky** login test\nand open a PR"), "fix the flaky login test");
  assert.equal(automaticConversationName("\n\n  # Release 0.16\n"), "Release 0.16");
  assert.equal(automaticConversationName("修复登录测试的偶发失败"), "修复登录测试的偶发失败");
  assert.equal(automaticConversationName("@codex"), "New conversation");
  const long = automaticConversationName(
    "Make the pages editor render tables and headings as a document while keeping markdown underneath");
  assert.ok(long.length <= 61 && long.endsWith("…"), long);
  assert.ok(!long.slice(0, -1).endsWith(" "));
});
