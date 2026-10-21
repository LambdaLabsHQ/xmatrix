const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState, TextSelection } = require("prosemirror-state");
const { markdownToPageDoc, pageDocToMarkdown, pageSchema } = require("@xmatrix/protocol/page-document");
const { insertReference, pageTriggerAt } = require("./page-triggers.ts");

const PAGE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CHANNEL = "bd319fa4-85f7-786b-01fb-a6c6cdf23291";

/** The page `markdown` with the caret at the end of `needle`'s first occurrence. */
function typed(markdown, needle) {
  const doc = markdownToPageDoc(markdown);
  let at = null;
  doc.descendants((node, pos) => {
    if (at !== null || !node.isText || !node.text.includes(needle)) return;
    at = pos + node.text.indexOf(needle) + needle.length;
  });
  assert.notEqual(at, null, `missing ${JSON.stringify(needle)}`);
  return EditorState.create({ doc, schema: pageSchema, selection: TextSelection.create(doc, at) });
}

function trigger(markdown, needle) {
  const state = typed(markdown, needle);
  const found = pageTriggerAt(state);
  return found && { ...found, typed: state.doc.textBetween(found.from, found.to) };
}

test("[[, # and @ open their menus as they do in the composer", () => {
  assert.deepEqual(trigger("See [[Road", "[[Road"), { kind: "page", from: 5, to: 11, query: "Road", section: null, typed: "[[Road" });
  assert.equal(trigger("See [[Roadmap#Lau", "#Lau").section, "Lau");
  assert.deepEqual(trigger("Ask in #bu", "#bu"), { kind: "channel", from: 8, to: 11, query: "bu", typed: "#bu" });
  assert.deepEqual(trigger("Then @cla", "@cla"), { kind: "agent", from: 6, to: 10, query: "cla", typed: "@cla" });
  assert.equal(trigger("见【【路线", "【【路线").kind, "page");
  assert.equal(trigger("问＃bu", "＃bu").kind, "channel");
  assert.equal(trigger("请＠cla", "＠cla").kind, "agent");
  assert.equal(trigger("Add /tab", "/tab").kind, "insert");
});

test("headings, issues, emails and code stay as typed", () => {
  assert.equal(trigger("\\#", "#"), null);
  assert.equal(trigger("Fixed in #3484", "#3484"), null);
  assert.equal(trigger("Mail me@exam", "me@exam"), null);
  assert.equal(trigger("```\n[[Road\n```", "[[Road"), null);
  assert.equal(trigger("Run `@cla now`", "@cla"), null);
});

test("a pick replaces its trigger with the reference the page keeps", () => {
  const pick = (markdown, needle, token) => {
    const state = typed(markdown, needle);
    let next = null;
    insertReference(pageTriggerAt(state), token)(state, (tr) => { next = state.apply(tr); });
    return { markdown: pageDocToMarkdown(next.doc).trim(), caret: next.selection.from, doc: next.doc };
  };
  const page = pick("See [[Road and more", "[[Road", `page:${PAGE}#launch`);
  assert.equal(page.markdown, `See page:${PAGE}#launch and more`);
  // Past the space, where the reference reads as its chip.
  assert.equal(page.doc.textBetween(page.caret - 1, page.caret), " ");
  assert.equal(pick("See [[Road]] here", "[[Road", `page:${PAGE}`).markdown, `See page:${PAGE} here`);
  assert.equal(pick("Ask in #bu", "#bu", `channel:${CHANNEL}`).markdown, `Ask in channel:${CHANNEL}`);
  assert.equal(pick("Then ＠cla next", "＠cla", "@claude").markdown, "Then @claude next");
});
