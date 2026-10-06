"use client";

import { useLayoutEffect, useRef } from "react";
import { markdownToPageDoc, pageSchema } from "@xmatrix/protocol/page-document";
import { DOMSerializer, type Node as DocNode } from "prosemirror-model";

/**
 * A page's document drawn as the live editor draws it, before the editor has
 * synced (pages-live-document.md §4): the same schema, the same list items as
 * the editor's node view and the same root classes, so nothing reflows when
 * the editor takes its place.
 */
const serializer = new DOMSerializer({
  ...DOMSerializer.nodesFromSchema(pageSchema),
  // As the editor's list item view draws it: the content in a div, a task's checkbox before it.
  list_item: (node: DocNode) => node.attrs.checked === null
    ? ["li", { class: "", "data-checked": "" }, ["div", 0]]
    : ["li", { class: "page-task", "data-checked": String(node.attrs.checked) },
      ["input", { type: "checkbox", tabindex: "-1", ...(node.attrs.checked ? { checked: "" } : {}) }], ["div", 0]],
}, DOMSerializer.marksFromSchema(pageSchema));

export function renderPageDocument(markdown: string, target: HTMLElement): void {
  const doc = markdownToPageDoc(markdown);
  const fragment = serializer.serializeFragment(doc.content, { document: target.ownerDocument });
  target.replaceChildren(fragment);
  // An empty line holds a line's height in the editor, which gives it a trailing break.
  for (const block of target.querySelectorAll("p, h1, h2, h3, h4, h5, h6")) {
    if (!block.firstChild) block.append(Object.assign(target.ownerDocument.createElement("br"),
      { className: "ProseMirror-trailingBreak" }));
  }
}

/** Read only: a task's box does not tick here. */
export function PageDocumentStatic({ body, testId }: { body: string; testId?: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (host.current) renderPageDocument(body, host.current);
  }, [body]);
  return (
    <div ref={host} className="ProseMirror page-document" data-editable="false" translate="no" data-testid={testId}
      onClick={(event) => { if ((event.target as HTMLElement).tagName === "INPUT") event.preventDefault(); }} />
  );
}
