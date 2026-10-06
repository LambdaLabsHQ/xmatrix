import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { pageBlocks } from "../dist/index.js";
import { canonicalPageMarkdown, markdownToPageDoc, pageDocToMarkdown } from "../dist/page-document.js";

const CANONICAL = `# Relay

Status: **shipping** \`v0.16.444\`, see [the PR](https://github.com/o/r/pull/1 "PR") and snake_case_names.

## Next steps

- [ ] migrate the *Lambda* Space
- [x] ship ~~Phase 4~~
  - nested item

1. first
2. second

> A quote
>
> over two paragraphs

| Area | State | Count |
| :--- | :---: | ---: |
| Search | **Shipped** | 3 |
| Sync | | 4 |

\`\`\`ts title
const x = 1;
\`\`\`

---

line one\\
line two

<details><summary>raw</summary>kept</details>

![diagram](https://example.com/a.png "A")
`;

test("canonical page markdown is the identity through the document", () => {
  assert.equal(canonicalPageMarkdown(CANONICAL), CANONICAL);
});

test("the document models GFM structure, not markup", () => {
  const doc = markdownToPageDoc(CANONICAL).toJSON();
  const types = doc.content.map((node) => node.type);
  assert.deepEqual(types, ["heading", "paragraph", "heading", "bullet_list", "ordered_list", "blockquote", "table",
    "code_block", "horizontal_rule", "paragraph", "markdown", "paragraph"]);
  const tasks = doc.content[3].content.map((item) => item.attrs.checked);
  assert.deepEqual(tasks, [false, true]);
  assert.equal(doc.content[7].attrs.language, "ts title");
  assert.deepEqual(doc.content[6].content[0].content.map((cell) => cell.attrs.align), ["left", "center", "right"]);
});

test("any page markdown converts once to canonical form and then stays put", () => {
  const inputs = [
    "* star bullets\n* two\n\n__strong__ and _em_\n\nSetext\n======\n",
    "Text with [a ref][r] and ![img][r].\n\n[r]: https://example.com \"T\"\n",
    "Footnote[^1].\n\n[^1]: The note.\n",
    "**bold `code` inside** and a\nsoft break\n",
    "| a | b |\n|---|---|\n| 1 | 2 | 3 |\n| 4 |\n",
    "",
    "\n\n",
  ];
  const docs = new URL("../../../docs/", import.meta.url);
  for (const dir of ["", "design/", "architecture/", "operations/"]) {
    for (const name of readdirSync(new URL(dir, docs))) {
      if (name.endsWith(".md")) inputs.push(readFileSync(new URL(dir + name, docs), "utf8"));
    }
  }
  for (const input of inputs) {
    const once = canonicalPageMarkdown(input);
    assert.equal(canonicalPageMarkdown(once), once);
    assert.ok(markdownToPageDoc(once).eq(markdownToPageDoc(input)), "canonical form reads as the same document");
  }
});

test("canonical form keeps readable markdown", () => {
  assert.equal(canonicalPageMarkdown("RELAY_POSTGRES_CACHED and RelayPostgres*Coordinator ~1,100\n"),
    "RELAY_POSTGRES_CACHED and RelayPostgres*Coordinator ~1,100\n");
  assert.equal(canonicalPageMarkdown("#2737 split the suite\n"), "#2737 split the suite\n");
  assert.equal(canonicalPageMarkdown("\\# not a heading\n"), "\\# not a heading\n");
  assert.equal(canonicalPageMarkdown("**bold `code` inside**\n"), "**bold `code` inside**\n");
  assert.equal(canonicalPageMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n"), "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
});

test("a long page whose lines carry escapes canonicalizes in bounded time", () => {
  // Each escape is checked within its own lines, not by reparsing the page: a
  // 40 KB page used to take seconds, past what a page session can spend.
  const sections = Array.from({ length: 120 }, (_, index) =>
    `## Section ${index}\n\nA *note* about [link](https://example.com/${index}) and RelayPostgres*Coordinator.\n\n` +
    `- item with snake_case_name and a_b\n- \\# not a heading ${index}\n`);
  const input = sections.join("\n");
  const started = performance.now();
  const once = canonicalPageMarkdown(input);
  const elapsed = performance.now() - started;
  assert.equal(canonicalPageMarkdown(once), once);
  assert.ok(markdownToPageDoc(once).eq(markdownToPageDoc(input)));
  assert.ok(elapsed < 3_000, `canonicalized in ${elapsed.toFixed(0)} ms`);
});

test("markdown the schema does not model is kept verbatim", () => {
  const out = canonicalPageMarkdown("Footnote[^1] and <kbd>K</kbd>.\n\n[^1]: The note.\n");
  assert.equal(out, "Footnote[^1] and <kbd>K</kbd>.\n\n[^1]: The note.\n");
});

test("an empty page is an empty document", () => {
  assert.equal(pageDocToMarkdown(markdownToPageDoc("")), "");
  assert.equal(markdownToPageDoc("").childCount, 1);
});

test("section ids survive conversion", () => {
  const ids = (text) => pageBlocks(text).map((block) => block.id);
  assert.deepEqual(ids(canonicalPageMarkdown(CANONICAL)), ids(CANONICAL));
});

test("a revision's change reads as lines kept, removed and added", async () => {
  const { pageLineDiff } = await import("../dist/index.js");
  assert.deepEqual(pageLineDiff("# P\n\nIn progress\n", "# P\n\nShipped\n\nNotes\n"), [
    { kind: "same", lines: ["# P", ""] },
    { kind: "removed", lines: ["In progress"] },
    { kind: "added", lines: ["Shipped", "", "Notes"] },
  ]);
});

test("changed document blocks ignore a change of markdown style", async () => {
  const { pageChangedDocBlocks } = await import("../dist/page-document.js");
  const before = "# Status\n* one\n* two\n\n# Notes\nkept\n";
  assert.deepEqual(pageChangedDocBlocks(before, "# Status\n- one\n- two\n\n# Notes\nkept\n"), []);
  assert.deepEqual(pageChangedDocBlocks(before, "# Status\n- one\n- three\n\n# Notes\nkept\n"), ["status"]);
  assert.deepEqual(pageChangedDocBlocks(before, "# Status\n* one\n* two\n\n# Next\nnew\n"), ["next", "notes"]);
});

test("changed document blocks parse only the sections whose text differs", async () => {
  const { canonicalPageMarkdown, pageChangedDocBlocks } = await import("../dist/page-document.js");
  // A long page whose one section changed: the rest must never be parsed (XMATRIX-HUB-68/69).
  const untouched = Array.from({ length: 200 }, (_, index) => `## Part ${index}\n${"text ".repeat(200)}\n`).join("\n");
  const before = `# Status\nold\n\n${untouched}`;
  const after = `# Status\nnew\n\n${untouched}`;
  const parsed = [];
  const canonical = (section) => {
    parsed.push(section);
    return canonicalPageMarkdown(section);
  };
  assert.deepEqual(pageChangedDocBlocks(before, after, canonical), ["status"]);
  assert.deepEqual(parsed, ["# Status\nold\n\n", "# Status\nnew\n\n"]);
  // A section already accounted for is not compared again.
  parsed.length = 0;
  assert.deepEqual(pageChangedDocBlocks(before, after.replace("## Part 7\n", "## Part 7\nmore\n"), canonical,
    new Set(["part-7"])), ["part-7"]);
  assert.equal(parsed.length, 2);
});
