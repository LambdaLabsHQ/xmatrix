const assert = require("node:assert/strict");
const test = require("node:test");

let editPageMarkdown, pageMarkdown, Y, PAGE_DOCUMENT_FRAGMENT;
test.before(async () => {
  ({ editPageMarkdown, pageMarkdown } = await import("./page-markdown-edit.ts"));
  Y = await import("yjs");
  ({ PAGE_DOCUMENT_FRAGMENT } = await import("@xmatrix/protocol"));
});

test("a repeated Markdown edit preserves the reader's unfinished word separator", () => {
  const doc = new Y.Doc();
  try {
    editPageMarkdown(doc, () => "Shipped", "agent");
    const fragment = doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT);
    const text = fragment.get(0).get(0);
    text.insert(text.length, " and ");
    const before = Y.encodeStateAsUpdate(doc);
    editPageMarkdown(doc, (markdown) => markdown.replace("In progress", "Shipped"), "agent");
    const after = Y.encodeStateAsUpdate(doc);
    text.insert(text.length, "verified");
    assert.equal(pageMarkdown(doc).trim(), "Shipped and verified");
    assert.deepEqual(after, before, "a no-op must not rewrite live text");
  } finally {
    doc.destroy();
  }
});

test("an empty document still initializes and a real Markdown edit still applies", () => {
  const doc = new Y.Doc();
  try {
    editPageMarkdown(doc, () => "", "server");
    assert.equal(doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT).length, 1);
    editPageMarkdown(doc, () => "In progress", "server");
    editPageMarkdown(doc, (markdown) => markdown.replace("In progress", "Shipped"), "agent");
    assert.equal(pageMarkdown(doc).trim(), "Shipped");
  } finally {
    doc.destroy();
  }
});
