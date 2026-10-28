import type { Node as DocNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { isShortCell, SHORT_CELL_CLASS } from "./page-table-cells";

/** The editor's short cells (page-table-cells.ts), kept as the document changes. */
function shortCells(doc: DocNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "header_cell" || node.type.spec.tableRole === "cell") {
      if (isShortCell(node.textContent)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: SHORT_CELL_CLASS }));
      return false;
    }
    return node.isBlock;
  });
  return DecorationSet.create(doc, decorations);
}

export function tableCells(): Plugin {
  return new Plugin<DecorationSet>({
    state: {
      init: (_config, editor) => shortCells(editor.doc),
      apply: (tr, value) => tr.docChanged ? shortCells(tr.doc) : value,
    },
    props: { decorations(editor) { return this.getState(editor); } },
  });
}
