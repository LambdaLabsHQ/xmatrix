import { diff3Merge, diffComm, diffIndices } from "node-diff3";

/**
 * Markdown helpers shared by the page live session, the Web editor and the
 * CLI (docs/design/pages-and-conversations.md). A page's blocks are its
 * headings: a block id is the heading's slug, unique within the page.
 */

export interface PageBlock {
  /** Heading slug, unique within the page ('' for text before the first heading). */
  id: string;
  title: string;
  depth: number;
  /** Character offsets of the section: heading line through the line before the next heading of any depth. */
  start: number;
  end: number;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;

/** GitHub-style heading slug. */
export function pageHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-")
    .slice(0, 180);
}

/** Each line with its offsets, and whether it is prose: outside fenced code and not a fence itself. */
function* markdownLines(markdown: string): Generator<{ line: string; offset: number; end: number; prose: boolean }> {
  let offset = 0;
  let fence: string | null = null;
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const end = offset + line.length + (index < lines.length - 1 ? 1 : 0);
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
    }
    yield { line, offset, end, prose: fence === null && !fenceMatch };
    offset = end;
  }
}

/** The page's sections, in order; duplicate slugs get -1, -2 suffixes as on GitHub. */
export function pageBlocks(markdown: string): PageBlock[] {
  const blocks: PageBlock[] = [];
  const seen = new Map<string, number>();
  let current: PageBlock | null = null;
  for (const { line, offset, end: lineEnd, prose } of markdownLines(markdown)) {
    const heading = prose ? HEADING.exec(line) : null;
    if (heading) {
      if (current) current.end = offset;
      const base = pageHeadingSlug(heading[2]!) || "section";
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      current = { id: count ? `${base}-${count}` : base, title: heading[2]!, depth: heading[1]!.length,
        start: offset, end: lineEnd };
      blocks.push(current);
    } else if (!current && line.trim()) {
      current = { id: "", title: "", depth: 0, start: 0, end: lineEnd };
      blocks.push(current);
    }
    if (current) current.end = lineEnd;
  }
  return blocks;
}

/**
 * The titles of the top sections (heading depth 1 or 2) in `before` that
 * `after` no longer has, in page order: what a whole-document edit removed,
 * or renamed, at the level a reader would miss.
 */
export function pageRemovedSections(before: string, after: string): string[] {
  const top = (markdown: string) => pageBlocks(markdown).filter((block) => block.depth === 1 || block.depth === 2);
  const kept = new Set(top(after).map((block) => block.title.trim()));
  return [...new Set(top(before).map((block) => block.title.trim()).filter((title) => !kept.has(title)))];
}

/** The block containing a character offset, or '' before the first heading. */
export function pageBlockAt(markdown: string, offset: number): string {
  let id = "";
  for (const block of pageBlocks(markdown)) {
    if (block.start <= offset) id = block.id;
    else break;
  }
  return id;
}

/** Block ids whose section text differs between two versions of a page. */
export function pageChangedBlocks(before: string, after: string): string[] {
  const text = (markdown: string) => new Map(pageBlocks(markdown)
    .map((block) => [block.id, markdown.slice(block.start, block.end)]));
  const a = text(before);
  const b = text(after);
  const changed = new Set<string>();
  for (const [id, section] of b) if (a.get(id) !== section) changed.add(id);
  for (const id of a.keys()) if (!b.has(id)) changed.add(id);
  return [...changed];
}

function lines(text: string): string[] {
  // Keep line terminators so joining reproduces the text exactly.
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

export type PageMergeResult =
  | { ok: true; text: string }
  | { ok: false; conflicts: number };

/**
 * Line-based three-way merge: `ours` and `theirs` both started from `base`.
 * Non-overlapping changes combine; overlapping, different changes conflict.
 */
export function mergePageText(base: string, ours: string, theirs: string): PageMergeResult {
  if (ours === theirs || theirs === base) return { ok: true, text: ours };
  if (ours === base) return { ok: true, text: theirs };
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true });
  let conflicts = 0;
  let text = "";
  for (const region of regions) {
    if (region.ok) text += region.ok.join("");
    else conflicts++;
  }
  return conflicts ? { ok: false, conflicts } : { ok: true, text };
}

/** A revision's change as lines kept, removed and added, for showing it as a diff. */
export type PageLineDiff = Array<{ kind: "same" | "removed" | "added"; lines: string[] }>;

export function pageLineDiff(before: string, after: string): PageLineDiff {
  const out: PageLineDiff = [];
  const push = (kind: PageLineDiff[number]["kind"], lines: string[]) => {
    if (lines.length) out.push({ kind, lines: lines.map((line) => line.replace(/\n$/u, "")) });
  };
  for (const part of diffComm(lines(before), lines(after))) {
    if (part.common) push("same", part.common);
    else {
      push("removed", part.buffer1 ?? []);
      push("added", part.buffer2 ?? []);
    }
  }
  return out;
}

const GIST_LENGTH = 160;

/** A markdown line as the words a reader sees: no list, quote, emphasis or link syntax; a table row's cells joined. */
function plainPageLine(line: string): string {
  let text = line.trim();
  if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/u.test(text)) return "";
  if (text.startsWith("|")) {
    text = text.replace(/^\||\|$/gu, "").split("|").map((cell) => cell.trim()).filter(Boolean).join(" · ");
  }
  return text
    .replace(/^(?:>\s*)+/u, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, "")
    .replace(/<!--.*?-->/gu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/\*\*|__|~~|`|\*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * What a revision changed, in a line a list can show: the section it changed
 * and the first text it added there. A change that only removed text has no
 * gist; its section is the first one it changed.
 */
export function pageChangeGist(before: string, after: string): { blockId: string | null; gist: string | null } {
  const a = lines(before);
  const b = lines(after);
  const prose = [...markdownLines(after)];
  for (const hunk of diffIndices(a, b)) {
    const [start, length] = hunk.buffer2;
    for (let index = start; index < start + length; index++) {
      const line = prose[index];
      if (!line?.prose || HEADING.test(line.line)) continue;
      const gist = plainPageLine(line.line);
      if (gist) return { blockId: pageBlockAt(after, line.offset), gist: gist.slice(0, GIST_LENGTH) };
    }
  }
  return { blockId: pageChangedBlocks(before, after)[0] ?? null, gist: null };
}

const PAGE_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A section slug as `pageHeadingSlug` writes it (letters, digits, `_` and `-`). */
const PAGE_BLOCK_SLUG = "[\\p{L}\\p{N}_-]{1,180}";
const PAGE_REFERENCE = new RegExp(`(?:[?&]page=|\\bpage:)(${PAGE_ID})`, "giu");
/** A typed `page:<id>`, optional `#<section>` and `(rN)`, for rendering as an inline card in messages. */
const PAGE_REFERENCE_SPAN = new RegExp(
  `\\bpage:(${PAGE_ID})(?:#(${PAGE_BLOCK_SLUG}))?(?:\\s*\\(r(\\d+)\\))?`, "giu");

/** Page ids a message refers to: page links (`…/pages?page=<id>`) or `page:<id>` references. */
export function pageReferencesIn(body: string): string[] {
  return [...new Set([...body.matchAll(PAGE_REFERENCE)].map((match) => match[1]!.toLowerCase()))].slice(0, 10);
}

/** The text a message carries to refer to a page, or to one of its sections. */
export function pageReferenceToken(pageId: string, blockId?: string | null): string {
  return `page:${pageId.toLowerCase()}${blockId ? `#${blockId}` : ""}`;
}

/** One `page:<id>` span in message text, ready to replace with a live card. */
export interface PageReferenceSpan {
  pageId: string;
  /** The section the author pointed at, when they wrote `page:<id>#<section>`. */
  blockId: string | null;
  /** Revision the author named, when they wrote `page:<id> (rN)`. */
  revision: number | null;
  start: number;
  end: number;
  text: string;
}

/** Each typed `page:<id>` (with optional `#<section>` and `(rN)`) in order, for inline rendering. */
export function pageReferenceSpans(text: string): PageReferenceSpan[] {
  return [...text.matchAll(PAGE_REFERENCE_SPAN)].map((match) => ({
    pageId: match[1]!.toLowerCase(),
    blockId: match[2] ?? null,
    revision: match[3] ? Number(match[3]) : null,
    start: match.index!,
    end: match.index! + match[0].length,
    text: match[0],
  }));
}

/** The link scheme of an Automation's live reference (docs/design/pages-live-document.md §6.1). */
export const AUTOMATION_REFERENCE_SCHEME = "xmatrix:automation/";

const AUTOMATION_REFERENCE = /\]\(xmatrix:automation\/([A-Za-z0-9:._-]{1,200})\)/gu;

/** The markdown line that places an Automation in a section: a link its editor renders as a chip. */
export function automationReferenceMarkdown(automationId: string, name: string): string {
  const label = name.replace(/\s+/gu, " ").trim().replace(/[[\]\\]/gu, "\\$&") || "Automation";
  return `[${label}](${AUTOMATION_REFERENCE_SCHEME}${automationId})`;
}

/** Each Automation referenced in the page's text, outside code, with the section that holds its first reference. */
export function automationReferences(markdown: string): Map<string, string> {
  const references = new Map<string, string>();
  const blocks = pageBlocks(markdown);
  for (const { line, offset, prose } of markdownLines(markdown)) {
    if (!prose) continue;
    for (const match of line.replace(/`[^`]*`/gu, (code) => " ".repeat(code.length)).matchAll(AUTOMATION_REFERENCE)) {
      const id = match[1]!;
      if (references.has(id)) continue;
      const at = offset + match.index!;
      references.set(id, [...blocks].reverse().find((block) => block.start <= at)?.id ?? "");
    }
  }
  return references;
}

/** The page with an Automation's reference at the end of a section ('' or an unknown id: the end of the page). */
export function insertAutomationReference(markdown: string, blockId: string, automationId: string,
  name: string): string {
  const line = automationReferenceMarkdown(automationId, name);
  const block = blockId ? pageBlocks(markdown).find((candidate) => candidate.id === blockId) : undefined;
  const end = block ? block.end : markdown.length;
  const before = markdown.slice(0, end).replace(/\s+$/u, "");
  const after = markdown.slice(end);
  return `${before}${before ? "\n\n" : ""}${line}\n${after ? `\n${after.replace(/^\s+/u, "")}` : ""}`;
}

/** The page with every reference to one Automation pointing at another, as a replacement does. */
export function replaceAutomationReference(markdown: string, fromId: string, toId: string): string {
  return markdown.split(`](${AUTOMATION_REFERENCE_SCHEME}${fromId})`).join(`](${AUTOMATION_REFERENCE_SCHEME}${toId})`);
}

/** The page without any reference to an Automation; a line left with no words goes with it. */
export function removeAutomationReference(markdown: string, automationId: string): string {
  const target = `](${AUTOMATION_REFERENCE_SCHEME}${automationId})`;
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    let rest = line;
    for (let end = rest.indexOf(target); end >= 0; end = rest.indexOf(target)) {
      let start = rest.lastIndexOf("[", end);
      while (start > 0 && rest[start - 1] === "\\") start = rest.lastIndexOf("[", start - 2);
      rest = `${rest.slice(0, Math.max(0, start))}${rest.slice(end + target.length)}`;
    }
    if (rest === line) lines.push(line);
    else if (/[\p{L}\p{N}]/u.test(rest.replace(/^\s*\d+[.)]/u, ""))) lines.push(rest.replace(/[ \t]+$/u, ""));
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n");
}

/**
 * The link scheme of a GitHub file embedded in a page
 * (docs/design/pages-live-document.md §6.5): `xmatrix:github-file/<owner>/<repo>/<path>`,
 * with `?ref=<branch, tag or commit>` to pin it; without one it is the
 * repository's default branch. The editor draws the file below the link, read
 * through from GitHub each time; the page holds the reference, never the file.
 */
export const GITHUB_FILE_REFERENCE_SCHEME = "xmatrix:github-file/";

export interface GitHubFileReference {
  /** `owner/repo`. */
  repository: string;
  /** The file's path in the repository, without a leading slash. */
  path: string;
  /** A branch, tag or commit; null for the default branch. */
  ref: string | null;
}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/u;
const GITHUB_REF = /^[A-Za-z0-9._/-]{1,250}$/u;
const GITHUB_PATH_MAX = 500;
const GITHUB_FILE_REFERENCE = /\]\((xmatrix:github-file\/[^)\s]+)(?:\s+"[^"]*")?\)/gu;

function decodedSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** A path segment as a link destination carries it: parentheses too, so the markdown link stays whole. */
function encodedSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[()]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function gitHubFileReferenceOf(owner: string, repo: string, path: readonly string[],
  ref: string | null): GitHubFileReference | null {
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo) || repo === "." || repo === "..") return null;
  if (!path.length || path.some((part) => !part || part === "." || part === ".."
    || [...part].some((char) => char.charCodeAt(0) < 0x20))) {
    return null;
  }
  const joined = path.join("/");
  if (joined.length > GITHUB_PATH_MAX) return null;
  if (ref !== null && (!GITHUB_REF.test(ref) || ref.split("/").some((part) => !part || part === ".."))) return null;
  return { repository: `${owner}/${repo}`, path: joined, ref };
}

/** The reference a `xmatrix:github-file/…` link names; null for any other link or an invalid one. */
export function parseGitHubFileReference(href: string): GitHubFileReference | null {
  if (!href.startsWith(GITHUB_FILE_REFERENCE_SCHEME)) return null;
  const rest = href.slice(GITHUB_FILE_REFERENCE_SCHEME.length);
  const queryAt = rest.indexOf("?");
  const location = queryAt < 0 ? rest : rest.slice(0, queryAt);
  let ref: string | null = null;
  if (queryAt >= 0) {
    const query = new URLSearchParams(rest.slice(queryAt + 1));
    if ([...query.keys()].some((key) => key !== "ref")) return null;
    ref = query.get("ref") || null;
  }
  const parts = location.split("/").map(decodedSegment);
  if (parts.length < 3 || parts.some((part) => part === null)) return null;
  const [owner, repo, ...path] = parts as string[];
  return gitHubFileReferenceOf(owner!, repo!, path, ref);
}

/** The link destination that embeds a file; the same reference always gives the same text. */
export function gitHubFileReferenceHref(reference: GitHubFileReference): string {
  const path = reference.path.split("/").map(encodedSegment).join("/");
  return `${GITHUB_FILE_REFERENCE_SCHEME}${reference.repository}/${path}${
    reference.ref ? `?ref=${encodeURIComponent(reference.ref)}` : ""}`;
}

/**
 * A file named by a GitHub link (`https://github.com/<owner>/<repo>/blob/<ref>/<path>`)
 * or by an embed's own link. The segment after `blob` is the ref, so a branch
 * whose name holds a `/` is written with `?ref=` instead.
 */
export function gitHubFileReferenceFrom(text: string): GitHubFileReference | null {
  const trimmed = text.trim();
  if (trimmed.startsWith(GITHUB_FILE_REFERENCE_SCHEME)) return parseGitHubFileReference(trimmed);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)) return null;
  const parts = url.pathname.replace(/^\/+|\/+$/gu, "").split("/").map(decodedSegment);
  if (parts.length < 5 || parts.some((part) => part === null) || parts[2] !== "blob") return null;
  const [owner, repo, , ref, ...path] = parts as string[];
  return gitHubFileReferenceOf(owner!, repo!, path, ref!);
}

/** Where the file is on GitHub, for a reader outside the editor. */
export function gitHubFileUrl(reference: GitHubFileReference): string {
  const ref = reference.ref ? reference.ref.split("/").map(encodedSegment).join("/") : "HEAD";
  return `https://github.com/${reference.repository}/blob/${ref}/${reference.path.split("/").map(encodedSegment).join("/")}`;
}

/** Each GitHub file the page's text embeds, outside code, as canonical link destinations in order. */
export function gitHubFileReferences(markdown: string): string[] {
  const references = new Set<string>();
  for (const { line, prose } of markdownLines(markdown)) {
    if (!prose) continue;
    for (const match of line.replace(/`[^`]*`/gu, (code) => " ".repeat(code.length)).matchAll(GITHUB_FILE_REFERENCE)) {
      const reference = parseGitHubFileReference(match[1]!);
      if (reference) references.add(gitHubFileReferenceHref(reference));
    }
  }
  return [...references];
}
