import type { Metadata } from "next";
import { pageBlocks } from "@xmatrix/protocol";

import { localizedPath, type SiteLocale } from "@/lib/site-locales";
import { localizedSitePageMetadata } from "@/lib/site-metadata";

import agentsEn from "../../../../../docs/guide/agents.md";
import aiAppsEn from "../../../../../docs/guide/ai-apps.md";
import cliEn from "../../../../../docs/guide/cli.md";
import conceptsEn from "../../../../../docs/guide/concepts.md";
import connectorsEn from "../../../../../docs/guide/connectors.md";
import indexEn from "../../../../../docs/guide/index.md";
import pagesEn from "../../../../../docs/guide/pages.md";
import programsEn from "../../../../../docs/guide/programs.md";
import projectWikiEn from "../../../../../docs/guide/project-wiki.md";
import syntaxEn from "../../../../../docs/guide/syntax.md";

import agentsZh from "../../../../../docs/guide/i18n/zh/agents.md";
import aiAppsZh from "../../../../../docs/guide/i18n/zh/ai-apps.md";
import cliZh from "../../../../../docs/guide/i18n/zh/cli.md";
import conceptsZh from "../../../../../docs/guide/i18n/zh/concepts.md";
import connectorsZh from "../../../../../docs/guide/i18n/zh/connectors.md";
import indexZh from "../../../../../docs/guide/i18n/zh/index.md";
import pagesZh from "../../../../../docs/guide/i18n/zh/pages.md";
import programsZh from "../../../../../docs/guide/i18n/zh/programs.md";
import projectWikiZh from "../../../../../docs/guide/i18n/zh/project-wiki.md";
import syntaxZh from "../../../../../docs/guide/i18n/zh/syntax.md";

import agentsZhTw from "../../../../../docs/guide/i18n/zh-tw/agents.md";
import aiAppsZhTw from "../../../../../docs/guide/i18n/zh-tw/ai-apps.md";
import cliZhTw from "../../../../../docs/guide/i18n/zh-tw/cli.md";
import conceptsZhTw from "../../../../../docs/guide/i18n/zh-tw/concepts.md";
import connectorsZhTw from "../../../../../docs/guide/i18n/zh-tw/connectors.md";
import indexZhTw from "../../../../../docs/guide/i18n/zh-tw/index.md";
import pagesZhTw from "../../../../../docs/guide/i18n/zh-tw/pages.md";
import programsZhTw from "../../../../../docs/guide/i18n/zh-tw/programs.md";
import projectWikiZhTw from "../../../../../docs/guide/i18n/zh-tw/project-wiki.md";
import syntaxZhTw from "../../../../../docs/guide/i18n/zh-tw/syntax.md";

import agentsJa from "../../../../../docs/guide/i18n/ja/agents.md";
import aiAppsJa from "../../../../../docs/guide/i18n/ja/ai-apps.md";
import cliJa from "../../../../../docs/guide/i18n/ja/cli.md";
import conceptsJa from "../../../../../docs/guide/i18n/ja/concepts.md";
import connectorsJa from "../../../../../docs/guide/i18n/ja/connectors.md";
import indexJa from "../../../../../docs/guide/i18n/ja/index.md";
import pagesJa from "../../../../../docs/guide/i18n/ja/pages.md";
import programsJa from "../../../../../docs/guide/i18n/ja/programs.md";
import projectWikiJa from "../../../../../docs/guide/i18n/ja/project-wiki.md";
import syntaxJa from "../../../../../docs/guide/i18n/ja/syntax.md";

import agentsKo from "../../../../../docs/guide/i18n/ko/agents.md";
import aiAppsKo from "../../../../../docs/guide/i18n/ko/ai-apps.md";
import cliKo from "../../../../../docs/guide/i18n/ko/cli.md";
import conceptsKo from "../../../../../docs/guide/i18n/ko/concepts.md";
import connectorsKo from "../../../../../docs/guide/i18n/ko/connectors.md";
import indexKo from "../../../../../docs/guide/i18n/ko/index.md";
import pagesKo from "../../../../../docs/guide/i18n/ko/pages.md";
import programsKo from "../../../../../docs/guide/i18n/ko/programs.md";
import projectWikiKo from "../../../../../docs/guide/i18n/ko/project-wiki.md";
import syntaxKo from "../../../../../docs/guide/i18n/ko/syntax.md";

import agentsEs from "../../../../../docs/guide/i18n/es/agents.md";
import aiAppsEs from "../../../../../docs/guide/i18n/es/ai-apps.md";
import cliEs from "../../../../../docs/guide/i18n/es/cli.md";
import conceptsEs from "../../../../../docs/guide/i18n/es/concepts.md";
import connectorsEs from "../../../../../docs/guide/i18n/es/connectors.md";
import indexEs from "../../../../../docs/guide/i18n/es/index.md";
import pagesEs from "../../../../../docs/guide/i18n/es/pages.md";
import programsEs from "../../../../../docs/guide/i18n/es/programs.md";
import projectWikiEs from "../../../../../docs/guide/i18n/es/project-wiki.md";
import syntaxEs from "../../../../../docs/guide/i18n/es/syntax.md";

type GuideSourceEntry = [file: string, markdown: string];

const sourcesByLocale: Readonly<Record<SiteLocale, readonly GuideSourceEntry[]>> = {
  en: [
    ["index", indexEn],
    ["project-wiki", projectWikiEn],
    ["concepts", conceptsEn],
    ["syntax", syntaxEn],
    ["agents", agentsEn],
    ["pages", pagesEn],
    ["programs", programsEn],
    ["connectors", connectorsEn],
    ["ai-apps", aiAppsEn],
    ["cli", cliEn],
  ],
  zh: [
    ["index", indexZh],
    ["project-wiki", projectWikiZh],
    ["concepts", conceptsZh],
    ["syntax", syntaxZh],
    ["agents", agentsZh],
    ["pages", pagesZh],
    ["programs", programsZh],
    ["connectors", connectorsZh],
    ["ai-apps", aiAppsZh],
    ["cli", cliZh],
  ],
  "zh-tw": [
    ["index", indexZhTw],
    ["project-wiki", projectWikiZhTw],
    ["concepts", conceptsZhTw],
    ["syntax", syntaxZhTw],
    ["agents", agentsZhTw],
    ["pages", pagesZhTw],
    ["programs", programsZhTw],
    ["connectors", connectorsZhTw],
    ["ai-apps", aiAppsZhTw],
    ["cli", cliZhTw],
  ],
  ja: [
    ["index", indexJa],
    ["project-wiki", projectWikiJa],
    ["concepts", conceptsJa],
    ["syntax", syntaxJa],
    ["agents", agentsJa],
    ["pages", pagesJa],
    ["programs", programsJa],
    ["connectors", connectorsJa],
    ["ai-apps", aiAppsJa],
    ["cli", cliJa],
  ],
  ko: [
    ["index", indexKo],
    ["project-wiki", projectWikiKo],
    ["concepts", conceptsKo],
    ["syntax", syntaxKo],
    ["agents", agentsKo],
    ["pages", pagesKo],
    ["programs", programsKo],
    ["connectors", connectorsKo],
    ["ai-apps", aiAppsKo],
    ["cli", cliKo],
  ],
  es: [
    ["index", indexEs],
    ["project-wiki", projectWikiEs],
    ["concepts", conceptsEs],
    ["syntax", syntaxEs],
    ["agents", agentsEs],
    ["pages", pagesEs],
    ["programs", programsEs],
    ["connectors", connectorsEs],
    ["ai-apps", aiAppsEs],
    ["cli", cliEs],
  ],
};

export interface GuidePage {
  /** File name without `.md`; `index` is the guide's first page. */
  file: string;
  basePath: string;
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

function guideBasePath(file: string): string {
  return file === "index" ? "/docs" : `/docs/${file}`;
}

/** A file opens with `---`, `title: "…"`, `description: "…"`, `---`; GitHub draws that as a table. */
const FRONT_MATTER = /^---\ntitle: "([^"\n]+)"\ndescription: "([^"\n]+)"\n---\n+/u;

function parseGuidePages(locale: SiteLocale): GuidePage[] {
  return sourcesByLocale[locale].map(([file, raw]) => {
    const source = raw.replaceAll("\r\n", "\n");
    const frontMatter = FRONT_MATTER.exec(source);
    if (!frontMatter) throw new Error(`guide/${locale}/${file}.md needs a front matter title and description`);
    const markdown = source.slice(frontMatter[0].length);
    const [title, ...sections] = pageBlocks(markdown).filter((block) => block.depth === 1 || block.depth === 2);
    const basePath = guideBasePath(file);
    return {
      file,
      basePath,
      href: localizedPath(locale, basePath),
      title: title!.title,
      searchTitle: frontMatter[1]!,
      description: frontMatter[2]!,
      body: markdown.slice(markdown.indexOf("\n", title!.start) + 1),
      sections: sections.map((block) => ({ id: block.id, title: block.title })),
    };
  });
}

const parsedByLocale = new Map<SiteLocale, GuidePage[]>();

export function guidePagesForLocale(locale: SiteLocale): GuidePage[] {
  let pages = parsedByLocale.get(locale);
  if (!pages) {
    pages = parseGuidePages(locale);
    parsedByLocale.set(locale, pages);
  }
  return pages;
}

export const guidePages: GuidePage[] = guidePagesForLocale("en");

export function findGuidePage(slug: string[] = [], locale: SiteLocale = "en"): GuidePage | undefined {
  if (slug.length > 1) return undefined;
  return guidePagesForLocale(locale).find(
    (page) => page.file === (slug[0] ?? "index") && (slug.length === 0 || page.file !== "index"),
  );
}

export function guidePageMetadata(slug: string[] | undefined, locale: SiteLocale): Metadata {
  const page = findGuidePage(slug, locale);
  if (!page) return {};
  return localizedSitePageMetadata(locale, page.basePath, page.searchTitle, page.description, "article");
}

/** `syntax.md#mentions` as written in the guide becomes `/docs/syntax#mentions` (or localized equivalent). */
export function guideLinkHref(href: string, locale: SiteLocale = "en"): string {
  const link = /^([a-z-]+)\.md(#.*)?$/u.exec(href);
  return link ? localizedPath(locale, guideBasePath(link[1]!)) + (link[2] ?? "") : href;
}
