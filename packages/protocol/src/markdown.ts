import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** The GFM tree shared by source-aware consumers, matching the message renderer. */
export function parseMarkdown(markdown: string): ReturnType<typeof fromMarkdown> {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}
