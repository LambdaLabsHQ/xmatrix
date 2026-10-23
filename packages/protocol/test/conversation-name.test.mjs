import assert from "node:assert/strict";
import test from "node:test";

import { automaticConversationName, discussionHead } from "../dist/index.js";

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

test("a discussion is named by what was written, not by the passage it quotes", () => {
  const head = discussionHead("加上任何人提交的页面修订（编辑、建议、评论）", {
    label: "Pages › Revisions", href: "https://xmatrix.sh/app/s/pages?page=p#r" });
  assert.equal(automaticConversationName(`${head}@codex 这条还成立吗？\n细节`), "这条还成立吗？");
  // Nothing written yet: the passage is all there is.
  assert.equal(automaticConversationName(head.trimEnd()), "加上任何人提交的页面修订（编辑、建议、评论）");
});
