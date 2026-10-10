import assert from "node:assert/strict";
import test from "node:test";

import { pageSummaryInput, pageSummaryLine, pageSummaryRequest } from "../src/page-summary.ts";

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

test("the page's text is handed over under its title, cut when it is longer than a task carries", () => {
  assert.equal(pageSummaryInput("Plan", "One\n"), "# Plan\n\nOne\n");
  const long = pageSummaryInput("Plan", "字".repeat(200_000));
  assert.ok(new TextEncoder().encode(long).length <= 256 * 1024);
  assert.ok(long.startsWith("# Plan\n\n字"));
});
