import * as Y from "yjs";
import { editPageMarkdown, pageMarkdown } from "../src/lib/pages/page-markdown-edit";

export { editPageMarkdown, pageMarkdown };

/**
 * A page session's document for a stand-in session, written and read as
 * markdown the way the Hub's page session does it.
 */
export function pageDocument(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  editPageMarkdown(doc, () => markdown, "server");
  return doc;
}
