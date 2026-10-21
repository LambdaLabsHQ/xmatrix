const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState } = require("prosemirror-state");
const { pageSchema } = require("@xmatrix/protocol/page-document");
const { undo, ySyncPlugin, ySyncPluginKey } = require("y-prosemirror");
const { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } = require("y-protocols/awareness");
const Y = require("yjs");
const { pageUndo } = require("./page-editor-setup.ts");

function paragraph(fragment, text, origin) {
  fragment.doc.transact(() => {
    const block = new Y.XmlElement("paragraph");
    block.insert(0, [new Y.XmlText(text)]);
    fragment.push([block]);
  }, origin);
}

/** Another writer's edit, as the session brings it in: written in their document, applied here. */
function written(fragment, session, peer, write) {
  const before = Y.encodeStateVector(peer.doc);
  write(peer.fragment);
  Y.applyUpdate(fragment.doc, Y.encodeStateAsUpdate(peer.doc, before), session);
}

function page(synced = false) {
  const listeners = new Set();
  const session = { synced, on: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("document");
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", { name: "Daniel", color: "#123456", kind: "user" });
  let changes = null;
  const plugins = pageUndo(fragment, session, awareness, (next) => { changes = next; });
  const state = EditorState.create({ schema: pageSchema, plugins: [ySyncPlugin(fragment), ...plugins] });
  plugins[0].spec.view({ state });
  const opened = plugins[1].spec.view();
  const peer = { doc: new Y.Doc() };
  peer.fragment = peer.doc.getXmlFragment("document");
  // Claude is on the page, named by its presence under its own client.
  const theirs = new Awareness(peer.doc);
  theirs.setLocalStateField("user", { name: "Claude", color: "#abcdef", kind: "agent" });
  applyAwarenessUpdate(awareness, encodeAwarenessUpdate(theirs, [peer.doc.clientID]), "remote");
  const sync = () => {
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(doc));
    session.synced = true;
    for (const listener of listeners) listener({ type: "synced" });
  };
  return {
    fragment, session, state, peer, changes: () => changes,
    // Presence checks on a timer, which would keep the test running.
    view: { destroy: () => { opened.destroy(); awareness.destroy(); theirs.destroy(); } },
    sync,
    /** The page opens; this person writes a paragraph, then Claude writes one. */
    mineThenTheirs: () => {
      sync();
      paragraph(fragment, "mine", ySyncPluginKey);
      Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(doc));
      written(fragment, session, peer, (theirs) => paragraph(theirs, "theirs"));
    },
    text: () => fragment.toArray().map((block) => block.toArray().map(String).join("")),
  };
}

test("Ctrl+Z steps back through everyone's writes, but not past the page as it opened", () => {
  const { fragment, session, state, view, text, mineThenTheirs } = page();
  paragraph(fragment, "opened", session);
  mineThenTheirs();
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

test("the list names each change's writer and what it wrote, and marks what Ctrl+Z undid", () => {
  const { state, view, changes, mineThenTheirs } = page();
  mineThenTheirs();
  const list = () => changes().changes.map(({ writer, added, state: done, undoable, redoable }) =>
    ({ writer: writer?.name ?? null, self: writer?.self ?? null, added, state: done, undoable, redoable }));
  assert.deepEqual(list(), [
    { writer: "Claude", self: false, added: "theirs", state: "done", undoable: true, redoable: false },
    { writer: "You", self: true, added: "mine", state: "done", undoable: true, redoable: false },
  ]);
  undo(state);
  assert.equal(changes().notice.kind, "undo");
  assert.equal(changes().notice.change.writer.name, "Claude");
  assert.deepEqual(list()[0], { writer: "Claude", self: false, added: "theirs", state: "undone", undoable: false, redoable: true },
    "an undone change stays listed, to be redone");
  changes().redoTo(changes().changes[0].id);
  assert.equal(changes().notice.kind, "redo");
  assert.equal(list()[0].state, "done");
  view.destroy();
});

test("a step in the list undoes it and every change after it; redoing it brings back what came before", () => {
  const { fragment, session, view, peer, sync, text, changes } = page();
  sync();
  paragraph(fragment, "one", ySyncPluginKey);
  Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(fragment.doc));
  written(fragment, session, peer, (theirs) => paragraph(theirs, "two"));
  paragraph(fragment, "three", ySyncPluginKey);
  const first = changes().changes.at(-1);
  changes().undoTo(first.id);
  assert.deepEqual(text(), []);
  assert.deepEqual(changes().changes.map((change) => change.state), ["undone", "undone", "undone"]);
  changes().redoTo(first.id);
  assert.deepEqual(text(), ["one"], "redoing it brings back only what came before it");
  paragraph(fragment, "four", ySyncPluginKey);
  assert.deepEqual(changes().changes.filter((change) => change.redoable), [], "a new write ends redo");
  view.destroy();
});
