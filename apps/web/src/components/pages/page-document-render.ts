import { markdownToPageDoc, pageDiffSchema, pageDocBlocks, pageSchema } from "@xmatrix/protocol/page-document";
import { DOMSerializer, type Node as DocNode, type Schema } from "prosemirror-model";
import { pageMediaElement, type PageMediaUrl } from "./page-media";
import { drawPageReferences, type PageReferenceTargets } from "./page-reference-chips";
import { markShortCells } from "./page-table-cells";
import { highlightDrawnCode } from "./page-code-highlight";

/**
 * Markdown drawn as the live editor draws a page (pages-live-document.md §4):
 * the same schema, the same list items as the editor's node view and the same
 * root classes. The page's preview and a GitHub file it embeds are drawn so.
 */
function serializerOf(schema: Schema): DOMSerializer {
  return new DOMSerializer({
    ...DOMSerializer.nodesFromSchema(schema),
    // As the editor's list item view draws it: the content in a div, a task's checkbox before it.
    list_item: (node: DocNode) => {
      const change = node.attrs.change ? { "data-change": String(node.attrs.change) } : {};
      return node.attrs.checked === null
        ? ["li", { class: "", "data-checked": "", ...change }, ["div", 0]]
        : ["li", { class: "page-task", "data-checked": String(node.attrs.checked), ...change },
          ["input", { type: "checkbox", tabindex: "-1", ...(node.attrs.checked ? { checked: "" } : {}) }], ["div", 0]];
    },
  }, DOMSerializer.marksFromSchema(schema));
}
const serializer = serializerOf(pageSchema);
let diffSerializer: DOMSerializer | null = null;

/** Draws a document into `target`, each of its top-level blocks one child, as the editor draws a page. */
function draw(doc: DocNode, by: DOMSerializer, target: HTMLElement, references?: PageReferenceTargets, mediaUrl?: PageMediaUrl) {
  target.replaceChildren(by.serializeFragment(doc.content, { document: target.ownerDocument }));
  // An empty line holds a line's height in the editor, which gives it a trailing break.
  for (const block of target.querySelectorAll("p, h1, h2, h3, h4, h5, h6")) {
    if (!block.firstChild) block.append(Object.assign(target.ownerDocument.createElement("br"),
      { className: "ProseMirror-trailingBreak" }));
  }
  // A file pasted into the page is drawn as the editor's image view draws it.
  for (const image of target.querySelectorAll("img")) {
    const media = pageMediaElement(image.getAttribute("src") ?? "", image.alt, mediaUrl ? { url: mediaUrl } : undefined);
    if (media) image.replaceWith(media);
  }
  markShortCells(target);
  highlightDrawnCode(target);
  if (references) drawPageReferences(target, references);
}

/**
 * Draws what changed between two versions of a page (`pageDocDiff`) into `target`, as a page is drawn:
 * a change is the document's own, so History shows it in the page's own type.
 */
export function renderPageDiff(diff: DocNode, target: HTMLElement, references?: PageReferenceTargets,
  mediaUrl?: PageMediaUrl): void {
  diffSerializer ??= serializerOf(pageDiffSchema());
  draw(diff, diffSerializer, target, references, mediaUrl);
}

/** Draws the markdown into `target`; returns each section's heading by the id the editor gives it. */
export function renderPageDocument(markdown: string, target: HTMLElement, references?: PageReferenceTargets,
  mediaUrl?: PageMediaUrl): Map<string, Element> {
  const doc = markdownToPageDoc(markdown);
  draw(doc, serializer, target, references, mediaUrl);
  // The document's top-level nodes are the target's children, in order.
  const childAt = new Map<number, number>();
  doc.forEach((_node, offset, index) => childAt.set(offset, index));
  const headings = new Map<string, Element>();
  for (const block of pageDocBlocks(doc)) {
    const heading = target.children[childAt.get(block.pos) ?? -1];
    if (heading) headings.set(block.id, heading);
  }
  return headings;
}
