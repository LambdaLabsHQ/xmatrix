/**
 * The page store's git view as an Open Knowledge Format bundle
 * (https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf,
 * v0.2; docs/design/pages-and-conversations.md §5.4). Each page is a concept
 * whose frontmatter xMatrix writes, `page:<id>` references become
 * bundle-absolute links, and every directory carries an `index.md`. A push
 * reads the same text back: the frontmatter is set aside and the links turn
 * back into `page:<id>`.
 */

export const OKF_VERSION = "0.2";
export const OKF_PAGE_TYPE = "xMatrix Page";
/** Filenames OKF reserves at every level; they are never pages. */
export const OKF_RESERVED = new Set(["index.md", "log.md"]);

export function isReservedFile(path: string): boolean {
  return OKF_RESERVED.has(path.split("/").at(-1)!);
}

export interface PageConcept {
  pageId: string;
  title: string;
  revision: number;
  body: string;
  author: { kind: string; id: string; label: string };
  createdAt: string;
  resource: string;
}

const PAGE_ID = "[0-9A-Za-z][0-9A-Za-z_-]{0,79}";
const FRAGMENT = "(#[\\p{L}\\p{N}_-]{1,180})?";

/** An actor in OKF's convention (§7): `human:<id>` for a person, `<producer>/<version>` for an Agent. */
export function okfActor(author: PageConcept["author"]): string {
  if (author.kind === "user") return `human:${author.id}`;
  const name = author.label.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `${name || "agent"}/xmatrix`;
}

/** The first sentence-bearing line of a page, as the concept's one-line description. */
export function pageDescription(body: string): string | null {
  let fenced = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) { fenced = !fenced; continue; }
    if (fenced || !line || /^(#|\||>|---|<|!\[)/u.test(line)) continue;
    const text = line.replace(/^([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/u, "").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    if (text.length <= 200) return text;
    const cut = text.slice(0, 200);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120))}…`;
  }
  return null;
}

/** `page:<id>` references as links an OKF reader follows; pages this reader has no file for stay as written. */
export function linkPages(body: string, fileOf: ReadonlyMap<string, string>): string {
  const target = (pageId: string, fragment: string | undefined) => {
    const file = fileOf.get(pageId) ?? fileOf.get(pageId.toLowerCase());
    return file ? `/${file}${fragment ?? ""}` : null;
  };
  return body
    .replace(new RegExp(`\\]\\(page:(${PAGE_ID})${FRAGMENT}\\)`, "gu"), (whole, pageId: string, fragment?: string) => {
      const link = target(pageId, fragment);
      return link ? `](${link})` : whole;
    })
    .replace(new RegExp(`(?<![\\[(\\w])page:(${PAGE_ID})${FRAGMENT}`, "gu"), (whole, pageId: string, fragment?: string) => {
      const link = target(pageId, fragment);
      return link ? `[${whole}](${link})` : whole;
    });
}

/** A bundle path from a link written in `fromFile`: bundle-absolute (`/a/b.md`) or relative to its directory. */
export function resolveBundlePath(fromFile: string, link: string): string | null {
  const parts = link.startsWith("/") ? [] : fromFile.split("/").slice(0, -1);
  for (const segment of link.replace(/^\/+/u, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(segment);
  }
  return parts.length ? parts.join("/") : null;
}

/** The inverse of `linkPages`: links to page files in the bundle read as `page:<id>` again. */
export function unlinkPages(body: string, file: string, pageByFile: ReadonlyMap<string, string>): string {
  return body
    .replace(new RegExp(`\\[(page:${PAGE_ID}${FRAGMENT})\\]\\([^)\\s]*\\)`, "gu"), "$1")
    .replace(/\]\((?![a-z][a-z0-9+.-]*:)([^)\s]+?\.md)(#[^)\s]*)?\)/giu, (whole, link: string, fragment?: string) => {
      let decoded: string;
      try { decoded = decodeURIComponent(link); } catch { return whole; }
      const path = resolveBundlePath(file, decoded);
      const pageId = path ? pageByFile.get(path) : undefined;
      return pageId ? `](page:${pageId}${fragment ?? ""})` : whole;
    });
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** A page as an OKF concept document: frontmatter xMatrix writes, then the page's text. */
export function conceptDocument(page: PageConcept, fileOf: ReadonlyMap<string, string>): string {
  const description = pageDescription(page.body);
  const lines = [
    "---",
    `type: ${OKF_PAGE_TYPE}`,
    `title: ${yamlString(page.title)}`,
    ...(description ? [`description: ${yamlString(description)}`] : []),
    `resource: ${yamlString(page.resource)}`,
    `generated: { by: ${yamlString(okfActor(page.author))}, at: ${page.createdAt} }`,
    `xmatrix_page: ${yamlString(page.pageId)}`,
    `xmatrix_revision: ${page.revision}`,
    "---",
  ];
  return `${lines.join("\n")}\n${linkPages(page.body, fileOf)}`;
}

/** A document's frontmatter block (with its fences) and the text after it; no block reads as all text. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const normalized = text.startsWith("﻿") ? text.slice(1) : text;
  const opening = /^---\r?\n/u.exec(normalized);
  if (!opening) return { frontmatter: null, body: text };
  const closing = /^---[ \t]*(\r?\n|$)/mu.exec(normalized.slice(opening[0].length));
  if (!closing) return { frontmatter: null, body: text };
  const end = opening[0].length + closing.index + closing[0].length;
  return { frontmatter: normalized.slice(0, end), body: normalized.slice(end) };
}

/** A frontmatter block's top-level `title`, quoted or plain. */
export function frontmatterTitle(frontmatter: string | null): string | null {
  const raw = frontmatter ? /^title:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter)?.[1] : undefined;
  if (!raw) return null;
  if (raw.startsWith("\"")) {
    try { return String(JSON.parse(raw)); } catch { return null; }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) return raw.slice(1, -1).replace(/''/gu, "'");
  return raw.replace(/\s+#.*$/u, "") || null;
}

/** `name` is a file or directory name pagePaths wrote: a slug, safe in a link as it is. */
export interface IndexEntry { name: string; title: string; description: string | null; directory: boolean }

/** A directory's `index.md` (§8): one section listing its pages and the directories below them. */
export function indexDocument(heading: string, entries: readonly IndexEntry[], root: boolean): string {
  const lines = entries.map((entry) => {
    const href = entry.directory ? `${entry.name}/` : entry.name;
    const label = entry.title.replace(/[[\]\n]/gu, " ");
    return `* [${label}](${href})${entry.description ? ` - ${entry.description}` : ""}`;
  });
  const head = root ? `---\nokf_version: ${yamlString(OKF_VERSION)}\n---\n` : "";
  return `${head}# ${heading.replace(/\n/gu, " ")}\n\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}
