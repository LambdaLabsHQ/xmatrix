import assert from "node:assert/strict";
import test from "node:test";

import { automationReferences, insertAutomationReference, mergePageText, pageBlockAt, pageBlocks, pageChangeGist, pageChangedBlocks, pageHeadingSlug, removeAutomationReference, replaceAutomationReference } from "../dist/index.js";

const page = `Intro line
# Relay Storage
Status: in progress

## Goals
- ship

\`\`\`md
# not a heading
\`\`\`

## Goals
again
`;

test("blocks are headings with GitHub-style unique slugs; fenced code is not a heading", () => {
  assert.equal(pageHeadingSlug("Relay: Storage & Sync!"), "relay-storage--sync");
  assert.equal(pageHeadingSlug("现状 Status"), "现状-status");
  assert.deepEqual(pageBlocks(page).map((block) => [block.id, block.depth]),
    [["", 0], ["relay-storage", 1], ["goals", 2], ["goals-1", 2]]);
  const goals = pageBlocks(page)[2];
  assert.match(page.slice(goals.start, goals.end), /^## Goals\n- ship\n\n```md\n# not a heading\n```\n\n$/u);
  assert.equal(pageBlockAt(page, page.indexOf("Status:")), "relay-storage");
  assert.equal(pageBlockAt(page, 0), "");
});

test("changed blocks name only the sections whose text differs", () => {
  const after = page.replace("- ship", "- shipped");
  assert.deepEqual(pageChangedBlocks(page, after), ["goals"]);
  assert.deepEqual(pageChangedBlocks(page, page.replace("## Goals\nagain\n", "")), ["goals-1"]);
});

test("three-way merge combines separate edits and refuses overlapping ones", () => {
  const base = "# A\nstatus: old\n\n# B\nnotes\n";
  const ours = "# A\nstatus: new\n\n# B\nnotes\n";
  const theirs = "# A\nstatus: old\n\n# B\nnotes\nmore notes\n";
  assert.deepEqual(mergePageText(base, ours, theirs), { ok: true, text: "# A\nstatus: new\n\n# B\nnotes\nmore notes\n" });
  assert.deepEqual(mergePageText(base, ours, "# A\nstatus: other\n\n# B\nnotes\n"), { ok: false, conflicts: 1 });
  assert.deepEqual(mergePageText(base, ours, ours), { ok: true, text: ours });
  assert.deepEqual(mergePageText(base, base, theirs), { ok: true, text: theirs });
});

test("page references are page links or page: ids, deduplicated and bounded", async () => {
  const { pageReferencesIn } = await import("../dist/index.js");
  const id = "0b7c2a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e";
  assert.deepEqual(pageReferencesIn(`see https://xmatrix.sh/app/lambda/pages?page=${id} and page:${id.toUpperCase()}`), [id]);
  assert.deepEqual(pageReferencesIn("no pages here, page:not-an-id"), []);
});

test("typed page: spans keep an optional revision for inline chips", async () => {
  const { pageReferenceSpans, loneMessageReference } = await import("../dist/index.js");
  const id = "0b7c2a1e-4f3d-4c2b-9a8e-1d2c3b4a5f6e";
  assert.deepEqual(pageReferenceSpans(`updated page:${id} (r6): done`), [{
    pageId: id, blockId: null, revision: 6, start: 8, end: 8 + `page:${id} (r6)`.length, text: `page:${id} (r6)`,
  }]);
  assert.equal(loneMessageReference(`page:${id}`)?.pageId, id);
  assert.equal(loneMessageReference(`page:${id} (r3)`)?.revision, 3);
  assert.equal(loneMessageReference(`see page:${id}`), null);
});

test("an Automation's reference is found outside code, in the section that holds it", () => {
  const page = "# Goals\n\n## Architecture\n\n- Cadence: [Code audit](xmatrix:automation/a-1)\n\n" +
    "```\n[x](xmatrix:automation/in-code)\n```\n\n## UI\n\n`[y](xmatrix:automation/inline-code)` " +
    "[UI sweep](xmatrix:automation/b-2) and again [UI sweep](xmatrix:automation/a-1)\n";
  assert.deepEqual([...automationReferences(page)], [["a-1", "architecture"], ["b-2", "ui"]]);
});

test("a reference is placed at the end of its section and renamed ids follow a replacement", () => {
  const page = "# Goals\n\n## Architecture\n\nNo bloat.\n\n## UI\n\nConsistent.\n";
  const placed = insertAutomationReference(page, "architecture", "a-1", "Code [audit]");
  assert.equal(placed, "# Goals\n\n## Architecture\n\nNo bloat.\n\n[Code \\[audit\\]](xmatrix:automation/a-1)\n\n## UI\n\nConsistent.\n");
  assert.deepEqual([...automationReferences(placed)], [["a-1", "architecture"]]);
  assert.equal(insertAutomationReference("", "", "z", "Z"), "[Z](xmatrix:automation/z)\n");
  assert.equal(insertAutomationReference(page, "missing", "z", "Z"), `${page.trimEnd()}\n\n[Z](xmatrix:automation/z)\n`);
  const replaced = replaceAutomationReference(placed, "a-1", "a-2");
  assert.deepEqual([...automationReferences(replaced)], [["a-2", "architecture"]]);
});

test("removing an Automation's reference drops a line left without words", () => {
  const page = "## Architecture\n\n- Cadence: [Code \\[audit\\]](xmatrix:automation/a-1)\n- [Only](xmatrix:automation/a-1)\n\n" +
    "[Alone](xmatrix:automation/a-1)\n\nKeep [other](xmatrix:automation/b-2).\n";
  assert.equal(removeAutomationReference(page, "a-1"),
    "## Architecture\n\n- Cadence:\n\nKeep [other](xmatrix:automation/b-2).\n");
});

test("a change's gist is the first text it added, as a reader sees it, in the section it is in", () => {
  const before = "# Plan\nIntro\n\n## Status\n| Item | State |\n| --- | --- |\n| Relay | open |\n";
  assert.deepEqual(pageChangeGist(before,
    before + "- **Sentry** native install [passed](https://example.com) at `18:06`\n"),
  { blockId: "status", gist: "Sentry native install passed at 18:06" });
  assert.deepEqual(pageChangeGist(before, before.replace("| Relay | open |", "| Relay | done |")),
    { blockId: "status", gist: "Relay · done" }, "a table row reads as its cells");
  assert.deepEqual(pageChangeGist(before, before.replace("## Status", "## Next\n\n## Status")),
    { blockId: "next", gist: null }, "a heading alone is no gist; its section is the one changed");
  assert.deepEqual(pageChangeGist(before, before.replace("Intro\n", "")), { blockId: "plan", gist: null },
    "a change that only removed text names its section and has no gist");
  assert.deepEqual(pageChangeGist("Lead\n", "Lead\n> quoted *line*\n"), { blockId: "", gist: "quoted line" });
  assert.deepEqual(pageChangeGist(before, before + "```\ncode line\n```\n"), { blockId: "status", gist: null },
    "code is not a gist");
  assert.equal(pageChangeGist("", "x".repeat(400)).gist.length, 160);
});
