require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState } = require("prosemirror-state");
const { markdownToPageDoc, pageSchema } = require("@xmatrix/protocol/page-document");

/** A page document with the plugins whose decorations a test inspects. */
function pageEditorState(markdown, plugins) {
  return EditorState.create({ doc: markdownToPageDoc(markdown), schema: pageSchema, plugins });
}

module.exports = { pageEditorState };
