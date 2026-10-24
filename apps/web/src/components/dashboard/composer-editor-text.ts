import { Schema, type Node as DocNode } from "prosemirror-model";

/**
 * The composer's document is its draft text, one paragraph per line: the draft
 * string stays the single source and the document only displays it. These
 * helpers convert between the two and between draft offsets and document
 * positions, so callers keep reading and setting the draft as text.
 */
export const composerSchema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", parseDOM: [{ tag: "p" }, { tag: "div" }], toDOM: () => ["p", 0] },
    text: {},
  },
});

export function composerDocFromText(text: string): DocNode {
  return composerSchema.node("doc", null, text.split("\n").map((line) =>
    composerSchema.node("paragraph", null, line ? [composerSchema.text(line)] : [])));
}

export function composerTextOf(doc: DocNode): string {
  const lines: string[] = [];
  doc.forEach((paragraph) => lines.push(paragraph.textContent));
  return lines.join("\n");
}

/** Text of a fragment of the document (a copied slice), lines joined by `\n`. */
export function composerTextOfFragment(content: DocNode["content"]): string {
  const lines: string[] = [];
  content.forEach((node) => lines.push(node.isText ? node.text ?? "" : node.textContent));
  return lines.join("\n");
}

/** The document position of a draft offset: each line before it adds its paragraph's two boundaries. */
export function composerPosOf(doc: DocNode, offset: number): number {
  let remaining = Math.max(0, offset);
  let pos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const paragraph = doc.child(index);
    const length = paragraph.content.size;
    if (remaining <= length || index === doc.childCount - 1) return pos + 1 + Math.min(remaining, length);
    remaining -= length + 1;
    pos += paragraph.nodeSize;
  }
  return 1;
}

/** The draft offset of a document position. */
export function composerOffsetOf(doc: DocNode, pos: number): number {
  let offset = 0;
  let start = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const paragraph = doc.child(index);
    const end = start + paragraph.nodeSize;
    if (pos < end || index === doc.childCount - 1) {
      return offset + Math.max(0, Math.min(pos - start - 1, paragraph.content.size));
    }
    offset += paragraph.content.size + 1;
    start = end;
  }
  return offset;
}
