const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState, TextSelection } = require("prosemirror-state");
const { markdownToPageDoc, pageSchema } = require("@xmatrix/protocol/page-document");
const { markdownShortcuts, syntaxDecorations, typoraBackspace, typoraDelete } = require("./page-editor-syntax.ts");

function caret(markdown, needle, where) {
  const doc = markdownToPageDoc(markdown);
  let start = null;
  doc.descendants((node, pos) => {
    if (start !== null || !node.isText || !node.text.includes(needle)) return;
    start = pos + node.text.indexOf(needle);
  });
  assert.notEqual(start, null, `missing ${JSON.stringify(needle)} in ${JSON.stringify(markdown)}`);
  const pos = where === "end" ? start + needle.length : start;
  return EditorState.create({ doc, schema: pageSchema, selection: TextSelection.create(doc, pos) });
}

function drawn(state) {
  return syntaxDecorations(state).find(0, state.doc.content.size).map((deco) => deco.spec.syntax ?? deco.spec);
}

function apply(state, command) {
  let next = null;
  const handled = command(state, (tr) => { next = state.apply(tr); });
  assert.equal(handled, true);
  assert.ok(next);
  return next;
}

function type(plugin, text) {
  const doc = pageSchema.node("doc", null, [pageSchema.node("paragraph")]);
  let state = EditorState.create({
    doc, schema: pageSchema, plugins: [plugin], selection: TextSelection.create(doc, 1),
  });
  for (const ch of text) {
    const from = state.selection.from;
    let next = state;
    const view = { state, composing: false, dispatch(tr) { next = state.apply(tr); } };
    const handled = plugin.props.handleTextInput(view, from, from, ch);
    if (!handled) next = state.apply(state.tr.insertText(ch));
    state = next;
  }
  return state;
}

test("the caret's marks show their markdown, and another block does not", () => {
  const bold = drawn(caret("**Hello**", "Hello", "start"));
  assert.equal(bold.filter((item) => item === "**").length, 2);
  assert.deepEqual(drawn(caret("**Hello**\n\nthere", "there", "start")), []);

  const link = drawn(caret("See [docs](https://xmatrix.sh) now", "docs", "start"));
  assert.ok(link.includes("["));
  assert.ok(link.includes("](https://xmatrix.sh)"));

  assert.ok(drawn(caret("## Title", "Title", "start")).includes("## "));
  assert.ok(drawn(caret("> noted", "noted", "start")).includes("> "));
  assert.ok(drawn(caret("> ## Title", "Title", "start")).includes("> ## "));

  const code = drawn(caret("```ts\nconst a = 1\n```", "const", "start"));
  assert.equal(code.some((item) => item.fence === true), true);
  assert.equal(code.some((item) => typeof item === "string"), false);

  const linkEnd = drawn(caret("See [docs](https://xmatrix.sh) now", "docs", "end"));
  assert.equal(linkEnd.some((item) => String(item).startsWith("](")), false);
});

test("backspace removes the marker nearest the caret", () => {
  let heading = caret("## Title", "Title", "start");
  heading = apply(heading, typoraBackspace);
  assert.equal(heading.doc.firstChild.type.name, "heading");
  assert.equal(heading.doc.firstChild.attrs.level, 1);
  heading = apply(heading, typoraBackspace);
  assert.equal(heading.doc.firstChild.type.name, "paragraph");
  assert.equal(heading.doc.textContent, "Title");

  const quote = apply(caret("> noted", "noted", "start"), typoraBackspace);
  assert.equal(quote.doc.firstChild.type.name, "paragraph");
  assert.equal(quote.doc.textContent, "noted");

  const strong = apply(caret("**Hello**", "Hello", "start"), typoraBackspace);
  assert.equal(strong.doc.textContent, "Hello");
  assert.equal(strong.doc.firstChild.firstChild.marks.length, 0);

  const inside = caret("**Hello**", "He", "end");
  assert.equal(typoraBackspace(inside, () => { throw new Error("dispatched"); }), false);

  const cleared = apply(caret("**Hello**", "Hello", "end"), typoraDelete);
  assert.equal(cleared.doc.firstChild.firstChild.marks.length, 0);
});

test("typed markdown becomes the mark or block", () => {
  const plugin = markdownShortcuts();
  const bold = type(plugin, "**hi**");
  assert.equal(bold.doc.textContent, "hi");
  assert.equal(bold.doc.firstChild.firstChild.marks[0].type.name, "strong");

  const italic = type(plugin, "_hi_");
  assert.equal(italic.doc.textContent, "hi");
  assert.equal(italic.doc.firstChild.firstChild.marks[0].type.name, "em");

  const link = type(plugin, "See [docs](https://xmatrix.sh)");
  assert.equal(link.doc.textContent, "See docs");
  let href = null;
  link.doc.descendants((node) => {
    const mark = node.marks.find((item) => item.type.name === "link");
    if (mark) href = mark.attrs.href;
  });
  assert.equal(href, "https://xmatrix.sh");

  const image = type(plugin, "![alt](https://xmatrix.sh/a.png)");
  assert.equal(image.doc.firstChild.firstChild.type.name, "image");
  assert.equal(image.doc.firstChild.firstChild.attrs.src, "https://xmatrix.sh/a.png");
  assert.equal(image.doc.firstChild.firstChild.attrs.alt, "alt");

  const heading = type(plugin, "# Title");
  assert.equal(heading.doc.firstChild.type.name, "heading");
  assert.equal(heading.doc.firstChild.attrs.level, 1);
  assert.equal(heading.doc.textContent, "Title");

  const both = type(plugin, "***both***");
  assert.equal(both.doc.textContent, "both");
  const names = both.doc.firstChild.firstChild.marks.map((mark) => mark.type.name).sort();
  assert.deepEqual(names, ["em", "strong"]);

  const rule = type(plugin, "---");
  assert.equal(rule.doc.firstChild.type.name, "horizontal_rule");
});
