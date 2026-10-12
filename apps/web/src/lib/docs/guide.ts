import { pageBlocks } from "@xmatrix/protocol";

import agents from "../../../../../docs/guide/agents.md";
import cli from "../../../../../docs/guide/cli.md";
import concepts from "../../../../../docs/guide/concepts.md";
import connectors from "../../../../../docs/guide/connectors.md";
import index from "../../../../../docs/guide/index.md";
import pages from "../../../../../docs/guide/pages.md";
import projectWiki from "../../../../../docs/guide/project-wiki.md";
import syntax from "../../../../../docs/guide/syntax.md";

/**
 * The user guide: docs/guide/*.md in the repository, in reading order. A
 * page's title is its first heading and its address is its file name, so a
 * link between two files works on GitHub and here alike.
 */
const sources: [file: string, markdown: string][] = [
  ["index", index],
  ["project-wiki", projectWiki],
  ["concepts", concepts],
  ["syntax", syntax],
  ["agents", agents],
  ["pages", pages],
  ["connectors", connectors],
  ["cli", cli],
];

export interface GuidePage {
  /** File name without `.md`; `index` is the guide's first page. */
  file: string;
  href: string;
  title: string;
  /** The first paragraph, for search results and link previews. */
  description: string;
  /** The Markdown below the title. */
  body: string;
  sections: { id: string; title: string }[];
}

function guideHref(file: string): string {
  return file === "index" ? "/docs" : `/docs/${file}`;
}

export const guidePages: GuidePage[] = sources.map(([file, markdown]) => {
  const [title, ...sections] = pageBlocks(markdown).filter((block) => block.depth === 1 || block.depth === 2);
  const body = markdown.slice(markdown.indexOf("\n", title!.start) + 1);
  const description = body.split(/\n{2,}/u).map((part) => part.trim()).find(Boolean) ?? "";
  return {
    file,
    href: guideHref(file),
    title: title!.title,
    description: description.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1").replace(/[*_`]/gu, ""),
    body,
    sections: sections.map((block) => ({ id: block.id, title: block.title })),
  };
});

/** `syntax.md#mentions` as written in the guide becomes `/docs/syntax#mentions`. */
export function guideLinkHref(href: string): string {
  const link = /^([a-z-]+)\.md(#.*)?$/u.exec(href);
  return link ? guideHref(link[1]!) + (link[2] ?? "") : href;
}
