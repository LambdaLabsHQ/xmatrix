import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { pageBlocks } from "../dist/index.js";
import { Fragment, Slice } from "prosemirror-model";
import { canonicalPageMarkdown, markdownToPageDoc, pageDocToMarkdown, pageSchema, pageWritingPlan } from "../dist/page-document.js";

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
  const { pageChangedDocBlocks, pageChangedDocBlocksAsync } = await import("../dist/page-document.js");
  const before = "# Status\n* one\n* two\n\n# Notes\nkept\n";
  for (const changed of [pageChangedDocBlocks,
    (before, after) => pageChangedDocBlocksAsync(before, after, async (section) => canonicalPageMarkdown(section))]) {
    assert.deepEqual(await changed(before, "# Status\n- one\n- two\n\n# Notes\nkept\n"), []);
    assert.deepEqual(await changed(before, "# Status\n- one\n- three\n\n# Notes\nkept\n"), ["status"]);
    assert.deepEqual(await changed(before, "# Status\n* one\n* two\n\n# Next\nnew\n"), ["next", "notes"]);
  }
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

/**
 * Types a writing plan's runs into its start document, in order, as the session does: `upTo` words, and
 * never stopping right after a space while its run goes on, so no line is left ending in one.
 */
function typed(plan, upTo = Infinity) {
  let doc = plan.start;
  let shift = 0;
  let count = 0;
  for (const run of plan.runs) {
    for (const [index, word] of run.words.entries()) {
      const previous = run.words[index - 1];
      if (count >= upTo && !(previous && !previous.text.trim())) return doc;
      count++;
      doc = doc.replace(run.pos + shift, run.pos + shift, new Slice(Fragment.from(pageSchema.text(word.text, word.marks)), 0, 0));
      shift += word.text.length;
    }
  }
  return doc;
}

test("a writing plan starts from the change with its new words left out and types them in reading order", () => {
  const before = "# Launch\n\n- Web · Claude · in progress\n- Mobile · Codex · in progress\n";
  const after = "# Launch\n\n- Web · Claude · merged, live in v1.0.464\n- Mobile · Codex · in review, PR #566\n";
  const plan = pageWritingPlan(markdownToPageDoc(before), markdownToPageDoc(after));
  assert.doesNotMatch(pageDocToMarkdown(plan.start), /progress/u, "what it replaces goes at once");
  assert.match(pageDocToMarkdown(plan.start), /^# Launch\n\n- Web · Claude ·[^\n]*\n- Mobile · Codex ·[^\n]*\n$/u);
  assert.equal(plan.runs[0].words.find((word) => word.text.trim()).text, "merged", "it types from the first change on");
  assert.doesNotMatch(pageDocToMarkdown(plan.start), / \n| {2}/u, "no line ends in a space, nor holds two, before the words come");
  const partly = pageDocToMarkdown(typed(plan, 3));
  assert.match(partly, /Claude · merged,/u);
  assert.doesNotMatch(partly, /review/u, "the first change is typed first");
  assert.equal(pageDocToMarkdown(typed(plan)), after);
  const same = pageWritingPlan(markdownToPageDoc(after), markdownToPageDoc(after));
  assert.deepEqual(same.runs, []);
  const removal = pageWritingPlan(markdownToPageDoc(after), markdownToPageDoc("# Launch\n"));
  assert.equal(pageDocToMarkdown(removal.start), "# Launch\n");
  assert.deepEqual(removal.runs, [], "a pure removal types nothing");
});

// Markdown syntax must never be typed character by character: a half-written fence or table swallows the
// blocks after it. The plan types words into a structure that is already whole.
test("a writing plan keeps every structure whole and types only words, with their marks", () => {
  for (const body of [CANONICAL,
    "# T\n\n| Name | Status |\n| --- | --- |\n| Web | shipped today |\n\nAfter the table.\n",
    "# T\n\n```ts\nconst shipped = true;\nconst more = 2;\n```\n\nAfter the code.\n",
    "# T\n\nShipped **behind one switch** with [the launch docs](https://xmatrix.sh/docs) and `page edit` *today*.\n",
    "# T\n\n## Plan\n\nA new paragraph of words.\n\n- one\n- two with more\n  - nested item\n\n> quoted words\n",
    "# T\n\n会议马上开始，请大家准备好材料。\n\n- 第一项：Web 已上线\n"]) {
    const plan = pageWritingPlan(markdownToPageDoc("# T\n"), markdownToPageDoc(body));
    assert.equal(pageDocToMarkdown(typed(plan)), canonicalPageMarkdown(body), body);
    const total = plan.runs.reduce((n, run) => n + run.words.length, 0);
    assert.ok(total > 0, body);
    for (let upTo = 0; upTo <= total; upTo++) {
      // Every moment of the writing is a well-formed document that reads back from Markdown as itself: a
      // block is never half there or empty, only its words are. Another Agent's edit merges through it.
      const doc = typed(plan, upTo);
      doc.check();
      assert.equal(doc.childCount, plan.start.childCount, `${body} @${upTo}: the structure stands from the start`);
      assert.ok(markdownToPageDoc(pageDocToMarkdown(doc)).eq(doc), `${body} @${upTo}: ${JSON.stringify(pageDocToMarkdown(doc))}`);
    }
  }
  const marked = pageWritingPlan(markdownToPageDoc("# T\n"), markdownToPageDoc("# T\n\nShip **behind one switch** now\n"));
  const strong = marked.runs.flatMap((run) => run.words).filter((word) => word.marks.some((mark) => mark.type.name === "strong"));
  assert.equal(strong.map((word) => word.text).join(""), "behind one switch", "words carry their marks");
});

// Hand-picked documents cannot cover how two arbitrary versions align: many random edits of a rich page,
// each typed in from the other version, must end on it and read back as themselves all the way.
test("random edits of a rich page are typed in exactly, reading back as themselves at every moment", () => {
  let seed = 20261016;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const insertions = ["shipped", "**now**", "with [docs](https://xmatrix.sh/d)", "`code`", "会议", "and more words here",
    "\n\n- new item\n- another item", "\n\n## New section\n\nWith a paragraph.", "\n\n| x | y |\n| --- | --- |\n| 1 | 2 |",
    "\n\n```js\nlet a = 1;\n```", "*soon*", "PR #566"];
  const edit = (text) => {
    const lines = text.split("\n");
    for (let n = 0; n < 1 + Math.floor(random() * 4); n++) {
      const at = Math.floor(random() * lines.length);
      const line = lines[at];
      const words = line.split(" ");
      const r = random();
      if (r < 0.35 && words.length > 1) words.splice(Math.floor(random() * words.length), 1);
      else if (r < 0.75) words.splice(Math.floor(random() * (words.length + 1)), 0, pick(insertions));
      else lines.splice(at + 1, 0, pick(insertions));
      if (r < 0.75) lines[at] = words.join(" ");
    }
    return canonicalPageMarkdown(lines.join("\n"));
  };
  let checked = 0;
  for (let round = 0; round < 120; round++) {
    const before = round % 3 === 0 ? CANONICAL : edit(CANONICAL);
    const after = edit(before);
    const target = markdownToPageDoc(after);
    const plan = pageWritingPlan(markdownToPageDoc(before), target);
    const total = plan.runs.reduce((n, run) => n + run.words.length, 0);
    for (let upTo = 0; upTo <= total; upTo += 1 + Math.floor(random() * 3)) {
      const doc = typed(plan, upTo);
      doc.check();
      assert.ok(markdownToPageDoc(pageDocToMarkdown(doc)).eq(doc), `round ${round} @${upTo}: ${JSON.stringify(pageDocToMarkdown(doc))}`);
      checked++;
    }
    assert.ok(typed(plan).eq(target), `round ${round}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  assert.ok(checked > 300);
});
