const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState } = require("prosemirror-state");
const { markdownToPageDoc, pageSchema } = require("@xmatrix/protocol/page-document");
const { githubFileEmbeds } = require("./page-github-file-embeds.ts");

function embeds(markdown) {
  const plugin = githubFileEmbeds(() => undefined);
  const state = EditorState.create({ doc: markdownToPageDoc(markdown), schema: pageSchema, plugins: [plugin] });
  const decorations = plugin.getState(state).find();
  return {
    state,
    widgets: decorations.filter((decoration) => String(decoration.spec.key ?? "").startsWith("github-file:")),
    labels: decorations.filter((decoration) => decoration.type.attrs?.class === "page-github-file-link")
      .map((decoration) => state.doc.textBetween(decoration.from, decoration.to)),
  };
}

test("an embedded file is drawn below the paragraph that holds its link", () => {
  const { state, widgets, labels } = embeds("# Prompts\n\nSee [bootstrap.md](xmatrix:github-file/o/r/docs/bootstrap.md) here\n\n" +
    "- [a.md](xmatrix:github-file/o/r/a.md?ref=v1)\n");
  assert.deepEqual(widgets.map((widget) => widget.spec.key), [
    "github-file:0:xmatrix:github-file/o/r/docs/bootstrap.md",
    "github-file:0:xmatrix:github-file/o/r/a.md?ref=v1",
  ]);
  for (const widget of widgets) {
    assert.equal(state.doc.resolve(widget.from).nodeBefore?.type.name, "paragraph", "right after its paragraph");
  }
  assert.deepEqual(labels, ["bootstrap.md", "a.md"], "the link reads as the file's label");
});

test("ordinary links, invalid embeds and embeds in code stay text", () => {
  const { widgets, labels } = embeds("[site](https://example.com) [bad](xmatrix:github-file/o/r/../x.md)\n\n" +
    "[automation](xmatrix:automation/a-1)\n\n```\n[x](xmatrix:github-file/o/r/code.md)\n```\n");
  assert.deepEqual(widgets, []);
  assert.deepEqual(labels, []);
});

test("the same file embedded twice is drawn twice, each with its own key", () => {
  const { widgets } = embeds("[one](xmatrix:github-file/o/r/a.md)\n\n[two](xmatrix:github-file/o/r/a.md)\n");
  assert.deepEqual(widgets.map((widget) => widget.spec.key), [
    "github-file:0:xmatrix:github-file/o/r/a.md",
    "github-file:1:xmatrix:github-file/o/r/a.md",
  ]);
});
