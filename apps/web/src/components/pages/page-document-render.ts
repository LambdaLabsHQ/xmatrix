import { markdownToPageDoc, pageDocBlocks, pageSchema } from "@xmatrix/protocol/page-document";
import { DOMSerializer, type Node as DocNode } from "prosemirror-model";
import { pageMediaElement, type PageMediaUrl } from "./page-media";
import { drawPageReferences, type PageReferenceTargets } from "./page-reference-chips";

/**
 * Markdown drawn as the live editor draws a page (pages-live-document.md §4):
 * the same schema, the same list items as the editor's node view and the same
 * root classes. The page's preview and a GitHub file it embeds are drawn so.
 */
const serializer = new DOMSerializer({
  ...DOMSerializer.nodesFromSchema(pageSchema),
  // As the editor's list item view draws it: the content in a div, a task's checkbox before it.
  list_item: (node: DocNode) => node.attrs.checked === null
    ? ["li", { class: "", "data-checked": "" }, ["div", 0]]
    : ["li", { class: "page-task", "data-checked": String(node.attrs.checked) },
      ["input", { type: "checkbox", tabindex: "-1", ...(node.attrs.checked ? { checked: "" } : {}) }], ["div", 0]],
}, DOMSerializer.marksFromSchema(pageSchema));

/** Draws the markdown into `target`; returns each section's heading by the id the editor gives it. */
export function renderPageDocument(markdown: string, target: HTMLElement, references?: PageReferenceTargets,
  mediaUrl?: PageMediaUrl): Map<string, Element> {
  const doc = markdownToPageDoc(markdown);
  const fragment = serializer.serializeFragment(doc.content, { document: target.ownerDocument });
  target.replaceChildren(fragment);
  // The document's top-level nodes are the target's children, in order.
  const childAt = new Map<number, number>();
  doc.forEach((_node, offset, index) => childAt.set(offset, index));
  const headings = new Map<string, Element>();
  for (const block of pageDocBlocks(doc)) {
    const heading = target.children[childAt.get(block.pos) ?? -1];
    if (heading) headings.set(block.id, heading);
  }
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
  if (references) drawPageReferences(target, references);
  return headings;
}
