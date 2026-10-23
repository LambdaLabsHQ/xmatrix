require("../dashboard/typescript-require.cjs").installTypeScriptRequire();
const { EditorState } = require("prosemirror-state");
const { markdownToPageDoc, pageSchema } = require("@xmatrix/protocol/page-document");

// Builds a page editor state over markdown with one plugin, for plugin tests.
function pluginState(markdown, plugin) {
  return EditorState.create({ doc: markdownToPageDoc(markdown), schema: pageSchema, plugins: [plugin] });
}

module.exports = { pluginState };
