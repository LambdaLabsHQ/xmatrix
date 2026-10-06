import { PAGE_DOCUMENT_FRAGMENT } from "@xmatrix/protocol";
import { markdownToPageDoc, pageDocToMarkdown, pageSchema } from "@xmatrix/protocol/page-document";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";

/**
 * A page session's document for a stand-in session, written and read as
 * markdown the way the Hub's page session does it.
 */
export function pageDocument(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  editPageMarkdown(doc, () => markdown, "server");
  return doc;
}

export function pageMarkdown(doc: Y.Doc): string {
  return pageDocToMarkdown(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT), pageSchema));
}

/** An edit made on the session side, such as an Agent's. */
export function editPageMarkdown(doc: Y.Doc, change: (markdown: string) => string, origin: string): void {
  const fragment = doc.getXmlFragment(PAGE_DOCUMENT_FRAGMENT);
  const next = markdownToPageDoc(change(pageMarkdown(doc)));
  doc.transact(() => updateYFragment(doc, fragment, next, { mapping: new Map(), isOMark: new Map() }), origin);
}
