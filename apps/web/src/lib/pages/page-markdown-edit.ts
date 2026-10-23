import { PAGE_DOCUMENT_FRAGMENT } from "@xmatrix/protocol";
import { markdownToPageDoc, pageDocToMarkdown, pageSchema } from "@xmatrix/protocol/page-document";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import type * as Y from "yjs";

/** A page document as markdown, read the way the Hub's page session reads it. */
export function pageMarkdown(doc: Y.Doc): string {
  return pageDocToMarkdown(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT), pageSchema));
}

/** An edit made to a page document as markdown, as the session makes an Agent's. */
export function editPageMarkdown(doc: Y.Doc, change: (markdown: string) => string, origin: string): void {
  const fragment = doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT);
  const next = markdownToPageDoc(change(pageMarkdown(doc)));
  doc.transact(() => updateYFragment(doc, fragment, next, { mapping: new Map(), isOMark: new Map() }), origin);
}
