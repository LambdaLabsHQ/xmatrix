const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState, Plugin } = require("prosemirror-state");
const { pageSchema } = require("@xmatrix/protocol/page-document");
const {
  dropOwnedMedia, pageMediaOwnKey, pageMediaOwnSpec, releasePageMedia, rememberOwnedImages, retainPageMedia,
} = require("./page-media-own.ts");

const SRC = "xmatrix:page-media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
const OTHER = "xmatrix:page-media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png";

function image(src, alt) {
  return pageSchema.nodes.image.create({ src, alt });
}

function paragraph(...content) {
  return pageSchema.nodes.paragraph.create(null, content);
}

function editor(doc) {
  return EditorState.create({
    doc, schema: pageSchema,
    plugins: [new Plugin({ key: pageMediaOwnKey, state: pageMediaOwnSpec() })],
  });
}

function images(doc) {
  const found = [];
  doc.descendants((node) => {
    if (node.type.name === "image") found.push({ src: node.attrs.src, alt: node.attrs.alt });
  });
  return found;
}

function positionOf(doc, alt) {
  let at = null;
  doc.descendants((node, pos) => {
    if (at === null && node.type.name === "image" && node.attrs.alt === alt) at = pos;
  });
  assert.notEqual(at, null, `missing image ${alt}`);
  return at;
}

function insertOwned(state, at, items) {
  const { Fragment } = require("prosemirror-model");
  const tr = state.tr.insert(at, Fragment.from(items.map((item) => image(item.src, item.alt))));
  rememberOwnedImages(tr, { from: at, to: at }, items);
  return state.apply(tr);
}

test("a failed upload removes the image it inserted and leaves the same file already on the page", () => {
  let state = editor(pageSchema.nodes.doc.create(null, [
    paragraph(pageSchema.text("Before "), image(SRC, "kept"), pageSchema.text(" after")),
    paragraph(pageSchema.text("Next")),
  ]));
  const before = positionOf(state.doc, "kept");
  state = insertOwned(state, before, [{ id: "paste", src: SRC, alt: "new" }]);
  assert.deepEqual(images(state.doc).map((item) => item.alt), ["new", "kept"]);

  // Typing ahead of both images has to move the paste's positions with it.
  state = state.apply(state.tr.insertText("Hi", 1));
  state = state.apply(dropOwnedMedia(state, "paste"));

  assert.deepEqual(images(state.doc), [{ src: SRC, alt: "kept" }]);
  assert.match(state.doc.textContent, /HiBefore/);
  assert.match(state.doc.textContent, /Next/);
});

test("a paste at the caret owns only the image it inserted", () => {
  const { TextSelection } = require("prosemirror-state");
  const { Fragment, Slice } = require("prosemirror-model");
  let state = editor(pageSchema.nodes.doc.create(null, [
    paragraph(pageSchema.text("Before "), image(SRC, "kept")),
  ]));
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
  const selection = { from: state.selection.from, to: state.selection.to };
  const tr = state.tr.replaceSelection(new Slice(Fragment.from(image(SRC, "new")), 0, 0));
  rememberOwnedImages(tr, selection, [{ id: "paste", src: SRC }]);
  state = state.apply(tr);
  assert.deepEqual(images(state.doc).map((item) => item.alt), ["new", "kept"]);
  state = state.apply(dropOwnedMedia(state, "paste"));
  assert.deepEqual(images(state.doc), [{ src: SRC, alt: "kept" }]);
});

test("a failed upload beside an earlier copy of the same file does not take that copy", () => {
  let state = editor(pageSchema.nodes.doc.create(null, [
    paragraph(image(SRC, "kept")),
  ]));
  const after = positionOf(state.doc, "kept") + 1;
  state = insertOwned(state, after, [{ id: "paste", src: SRC, alt: "new" }]);
  state = state.apply(dropOwnedMedia(state, "paste"));
  assert.deepEqual(images(state.doc), [{ src: SRC, alt: "kept" }]);
});

test("one failed file in a paste leaves the other file that paste inserted", () => {
  let state = editor(pageSchema.nodes.doc.create(null, [paragraph()]));
  state = insertOwned(state, 1, [
    { id: "first", src: SRC, alt: "first" },
    { id: "second", src: OTHER, alt: "second" },
  ]);
  state = state.apply(dropOwnedMedia(state, "first"));
  assert.deepEqual(images(state.doc), [{ src: OTHER, alt: "second" }]);
});

test("a paste whose image was replaced, or already deleted, deletes nothing else", () => {
  let state = editor(pageSchema.nodes.doc.create(null, [
    paragraph(image(SRC, "kept"), pageSchema.text(" tail")),
  ]));
  state = insertOwned(state, positionOf(state.doc, "kept"), [{ id: "paste", src: SRC, alt: "new" }]);
  const pasted = positionOf(state.doc, "new");
  state = state.apply(state.tr.replaceWith(pasted, pasted + 1, image(OTHER, "changed")));
  state = state.apply(dropOwnedMedia(state, "paste"));
  assert.deepEqual(images(state.doc), [
    { src: OTHER, alt: "changed" },
    { src: SRC, alt: "kept" },
  ]);

  let gone = editor(pageSchema.nodes.doc.create(null, [paragraph(image(SRC, "kept"))]));
  gone = insertOwned(gone, positionOf(gone.doc, "kept"), [{ id: "paste", src: SRC, alt: "new" }]);
  const owned = positionOf(gone.doc, "new");
  gone = gone.apply(gone.tr.delete(owned, owned + 1));
  const before = gone.doc.toJSON();
  gone = gone.apply(dropOwnedMedia(gone, "paste"));
  assert.deepEqual(gone.doc.toJSON(), before);
});

test("a preview stays while any paste of that file still shows it", () => {
  const local = new Map();
  const revoked = [];
  const revoke = (url) => revoked.push(url);
  const first = retainPageMedia(local, "photo.png", () => "blob:photo");
  const second = retainPageMedia(local, "photo.png", () => "blob:other");
  assert.equal(second, first);
  assert.equal(first.holders, 2);

  releasePageMedia(local, "photo.png", second, revoke);
  assert.equal(local.has("photo.png"), true);
  assert.deepEqual(revoked, []);

  releasePageMedia(local, "photo.png", first, revoke);
  assert.equal(local.has("photo.png"), false);
  assert.deepEqual(revoked, ["blob:photo"]);
});
