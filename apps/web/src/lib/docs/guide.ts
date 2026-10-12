import { pageBlocks } from "@xmatrix/protocol";

import agents from "../../../../../docs/guide/agents.md";
import aiApps from "../../../../../docs/guide/ai-apps.md";
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
  ["ai-apps", aiApps],
  ["cli", cli],
];

export interface GuidePage {
  /** File name without `.md`; `index` is the guide's first page. */
  file: string;
  href: string;
  /** The page's heading, as the guide's own navigation names it. */
  title: string;
  /** What a search result shows: the file's front matter `title` and `description`. */
  searchTitle: string;
  description: string;
  /** The Markdown below the title. */
  body: string;
  sections: { id: string; title: string }[];
}

function guideHref(file: string): string {
  return file === "index" ? "/docs" : `/docs/${file}`;
}

/** A file opens with `---`, `title: "…"`, `description: "…"`, `---`; GitHub draws that as a table. */
const FRONT_MATTER = /^---\ntitle: "([^"\n]+)"\ndescription: "([^"\n]+)"\n---\n+/u;

export const guidePages: GuidePage[] = sources.map(([file, source]) => {
  const frontMatter = FRONT_MATTER.exec(source);
  if (!frontMatter) throw new Error(`docs/guide/${file}.md needs a front matter title and description`);
  const markdown = source.slice(frontMatter[0].length);
  const [title, ...sections] = pageBlocks(markdown).filter((block) => block.depth === 1 || block.depth === 2);
  return {
    file,
    href: guideHref(file),
    title: title!.title,
    searchTitle: frontMatter[1]!,
    description: frontMatter[2]!,
    body: markdown.slice(markdown.indexOf("\n", title!.start) + 1),
    sections: sections.map((block) => ({ id: block.id, title: block.title })),
  };
});

/** `syntax.md#mentions` as written in the guide becomes `/docs/syntax#mentions`. */
export function guideLinkHref(href: string): string {
  const link = /^([a-z-]+)\.md(#.*)?$/u.exec(href);
  return link ? guideHref(link[1]!) + (link[2] ?? "") : href;
}
