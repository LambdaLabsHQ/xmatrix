import assert from "node:assert/strict";
import test from "node:test";

import { pageSummaryAnswer, pageSummaryChange, pageSummaryInput, pageSummaryLine, pageSummaryRequest } from "../src/page-summary.ts";

test("a summary execution's id names the page and the revision it read", () => {
  const id = "page-summary:space-1:page-1:42:00000000-0000-4000-8000-000000000001";
  assert.deepEqual(pageSummaryRequest(id), { spaceId: "space-1", pageId: "page-1", revision: 42 });
  for (const other of ["harness:00000000-0000-4000-8000-000000000001", "page-summary:space-1:page-1:0:x",
    "page-summary:space-1:page-1:42", `${id}:more`]) assert.equal(pageSummaryRequest(other), null);
});

test("an answer becomes one line of at most 240 characters, without the quotes a harness wraps it in", () => {
  assert.equal(pageSummaryLine("  「就绪 41/47；\n阻塞项在下方」 \n"), "就绪 41/47； 阻塞项在下方");
  assert.equal(pageSummaryLine('"Ready: 41 of 47"'), "Ready: 41 of 47");
  assert.equal([...pageSummaryLine("字".repeat(500))].length, 240);
  assert.equal(pageSummaryLine(" \n "), "");
});

test("an answer is the page's line and, on its second line, what the change resulted in", () => {
  assert.deepEqual(pageSummaryAnswer("就绪 41/47；阻塞项在下方\nshipped: Replay 上了 beta\n"),
    { line: "就绪 41/47；阻塞项在下方", result: { kind: "shipped", text: "Replay 上了 beta" } });
  // The kind is read whatever its case, with either colon, and a harness's own line labels are dropped.
  assert.deepEqual(pageSummaryAnswer("Line 1: Ready: 41 of 47\n\nLine 2: Problem：最大的客户断充三天"),
    { line: "Ready: 41 of 47", result: { kind: "problem", text: "最大的客户断充三天" } });
  assert.deepEqual(pageSummaryAnswer("1. 1.2 版已上线\n2. number: 周活从 2 人跌到 1 人").result, { kind: "number", text: "周活从 2 人跌到 1 人" });
  assert.equal(pageSummaryAnswer("1.2 版已上线\nnone").line, "1.2 版已上线");
  // No result: the word none, one line only, a second line that names no kind, or a kind with nothing after it.
  for (const text of ["Ready\nnone", "Ready\nNone.", "Ready", "Ready\nand more of the summary", "Ready\nfixed:  "]) {
    assert.equal(pageSummaryAnswer(text).result, null, text);
  }
  assert.equal(pageSummaryAnswer("Ready\nand more of the summary").line, "Ready and more of the summary");
  // A first line that happens to begin with a kind is still the summary.
  assert.deepEqual(pageSummaryAnswer("problem: nobody recharged\ndecided: contact the customer"),
    { line: "problem: nobody recharged", result: { kind: "decided", text: "contact the customer" } });
  assert.equal([...pageSummaryAnswer(`Ready\nfixed: ${"字".repeat(500)}`).result.text].length, 240);
});

test("a change is handed over as the lines it added and took out", () => {
  assert.equal(pageSummaryChange("# Plan\n\nOne\n\nTwo\n", "# Plan\n\nOne\n\nThree\n\nFour\n"), "- Two\n+ Three\n+ Four");
  assert.equal(pageSummaryChange("", "# Plan\n\nOne\n"), "+ # Plan\n+ One");
  assert.equal(pageSummaryChange("# Plan\n", "# Plan\n"), "");
  assert.ok(pageSummaryChange("", `${"字".repeat(100)}\n`.repeat(1000)).length <= 24_000);
});

test("the change and the page's document are handed over as they read, cut when longer than a task carries", () => {
  assert.equal(pageSummaryInput("# Plan\n\nOne\n"), "<changed>\n\n</changed>\n\n# Plan\n\nOne\n");
  assert.equal(pageSummaryInput("# Plan\n\nOne\n", "+ One"), "<changed>\n+ One\n</changed>\n\n# Plan\n\nOne\n");
  const long = pageSummaryInput(`# Plan\n\n${"字".repeat(200_000)}`, "+ 字");
  assert.ok(new TextEncoder().encode(long).length <= 256 * 1024);
  assert.ok(long.startsWith("<changed>\n+ 字\n</changed>\n\n# Plan\n\n字"));
  const emojiCut = pageSummaryInput(`${"🚀".repeat(70_000)}\u0000\ud83d`);
  assert.ok(new TextEncoder().encode(emojiCut).length <= 256 * 1024);
  assert.doesNotMatch(JSON.stringify(emojiCut), /\\u0000|\\u[dD][89a-fA-F][0-9a-fA-F]{2}/u);
});
