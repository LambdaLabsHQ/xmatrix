const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState } = require("prosemirror-state");
const { pageSchema } = require("@xmatrix/protocol/page-document");
const { undo, ySyncPlugin, ySyncPluginKey } = require("y-prosemirror");
const Y = require("yjs");
const { pageUndo } = require("./page-editor-setup.ts");

function paragraph(fragment, text, origin) {
  fragment.doc.transact(() => {
    const block = new Y.XmlElement("paragraph");
    block.insert(0, [new Y.XmlText(text)]);
    fragment.push([block]);
  }, origin);
}

function page(synced = false) {
  const listeners = new Set();
  const session = { synced, on: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document");
  const plugins = pageUndo(fragment, session);
  const state = EditorState.create({ schema: pageSchema, plugins: [ySyncPlugin(fragment), ...plugins] });
  plugins[0].spec.view({ state });
  const view = plugins[1].spec.view();
  return {
    fragment, session, state, view,
    sync: () => { session.synced = true; for (const listener of listeners) listener({ type: "synced" }); },
    text: () => fragment.toArray().map((block) => block.toArray().map(String).join("")),
  };
}

test("Ctrl+Z steps back through everyone's writes, but not past the page as it opened", () => {
  const { fragment, session, state, view, sync, text } = page();
  paragraph(fragment, "opened", session);
  sync();
  paragraph(fragment, "mine", ySyncPluginKey);
  paragraph(fragment, "theirs", session);
  assert.deepEqual(text(), ["opened", "mine", "theirs"]);
  assert.equal(undo(state), true);
  assert.deepEqual(text(), ["opened", "mine"], "another writer's write is a step of its own");
  assert.equal(undo(state), true);
  assert.deepEqual(text(), ["opened"]);
  assert.equal(undo(state), false, "the page as it opened stays");
  assert.deepEqual(text(), ["opened"]);
  view.destroy();
});

test("a session already synced counts the others' writes from the start", () => {
  const { fragment, session, state, view, text } = page(true);
  paragraph(fragment, "theirs", session);
  assert.equal(undo(state), true);
  assert.deepEqual(text(), []);
  view.destroy();
});
