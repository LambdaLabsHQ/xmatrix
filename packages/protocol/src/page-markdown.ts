import { diff3Merge, diffComm, diffIndices } from "node-diff3";
import { trimEnd } from "./field-validation.js";
import { stripHtmlTags } from "./html-text.js";

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
const HEADING = /^\s{0,3}(#{1,6})\s(.*)$/u;

/** A heading line's text: no surrounding blanks or closing `#` run. */
function headingText(raw: string): string {
  return trimEnd(raw.trim(), "#").trimEnd();
}

/** GitHub-style heading slug. */
export function pageHeadingSlug(text: string): string {
  return stripHtmlTags(text.trim().toLowerCase())
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
      const title = headingText(heading[2]!);
      const base = pageHeadingSlug(title) || "section";
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      current = { id: count ? `${base}-${count}` : base, title, depth: heading[1]!.length,
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

/** Words for merging: line breaks, runs of other space, a CJK character each, runs of letters and digits, or one other character. */
const MERGE_WORD = /\n|[^\S\n]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}\p{M}_]+|\S/gu;

function mergeWords(text: string): string[] {
  return text.match(MERGE_WORD) ?? [];
}

function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= words.length && prefix.every((word, index) => words[index] === word);
}

function endsWithWords(words: readonly string[], suffix: readonly string[]): boolean {
  const offset = words.length - suffix.length;
  return offset >= 0 && suffix.every((word, index) => words[offset + index] === word);
}

/**
 * Three-way merge by line, and by word inside the lines both sides changed, so changes to
 * different words of one paragraph, or to neighbouring lines, combine (`mergePageText` keeps whole
 * lines apart). Where both changed the same words, `prefer` names the side that stays, and what the
 * other side only added at an edge of those words stays beside it, as two people typing at one place
 * both keep their words; without `prefer` such a merge fails.
 */
export function mergePageWords(base: string, ours: string, theirs: string, prefer: "ours" | "theirs"): { ok: true; text: string };
export function mergePageWords(base: string, ours: string, theirs: string): PageMergeResult;
export function mergePageWords(base: string, ours: string, theirs: string, prefer?: "ours" | "theirs"): PageMergeResult {
  if (ours === theirs || theirs === base) return { ok: true, text: ours };
  if (ours === base) return { ok: true, text: theirs };
  let conflicts = 0;
  let text = "";
  for (const region of diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true })) {
    if (region.ok) {
      text += region.ok.join("");
      continue;
    }
    const { a, o, b } = region.conflict!;
    for (const words of diff3Merge(mergeWords(a.join("")), mergeWords(o.join("")), mergeWords(b.join("")),
      { excludeFalseConflicts: true })) {
      if (words.ok) {
        text += words.ok.join("");
        continue;
      }
      if (!prefer) {
        conflicts++;
        continue;
      }
      const { a: mine, o: was, b: other } = words.conflict!;
      const [kept, added] = prefer === "ours" ? [mine, other] : [other, mine];
      if (startsWithWords(added, was)) text += [...kept, ...added.slice(was.length)].join("");
      else if (endsWithWords(added, was)) text += [...added.slice(0, added.length - was.length), ...kept].join("");
      else text += kept.join("");
    }
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
  return stripHtmlTags(text
    .replace(/^(?:>\s*)+/u, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1"))
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

/** One stretch of a changed line: kept as it was, or added or taken out. */
export interface PageEditSegment { text: string; change?: "added" | "removed" }

/**
 * One line a change touched, as a reader sees it: the section it is in, whether it is new, rewritten or taken
 * out, and its words with what was added and what was taken out marked where they stand, as a proofreader
 * marks paper. Markdown syntax is not shown.
 */
export interface PageEditGlimpse {
  /** The section's slug ('' before the first heading), and its title. */
  blockId: string;
  section: string;
  kind: "added" | "changed" | "removed";
  segments: PageEditSegment[];
}

/** Words of Latin script whole, and each CJK character alone, so a rewrite marks what a reader changed. */
const EDIT_TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[^\s]/gu;
/** Past this many tokens a rewritten line is shown as taken out and added whole, not word by word. */
const EDIT_TOKENS = 600;

function lineSegments(before: string, after: string): PageEditSegment[] {
  const a = before.match(EDIT_TOKEN) ?? [];
  const b = after.match(EDIT_TOKEN) ?? [];
  if (a.length > EDIT_TOKENS || b.length > EDIT_TOKENS) {
    return [{ text: before, change: "removed" }, { text: " " }, { text: after, change: "added" }];
  }
  const segments: PageEditSegment[] = [];
  const push = (text: string, change?: PageEditSegment["change"]) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last && last.change === change) last.text += text;
    else segments.push(change ? { text, change } : { text });
  };
  for (const part of diffComm(a, b)) {
    if (part.common) push(part.common.join(""));
    else {
      push((part.buffer1 ?? []).join(""), "removed");
      push((part.buffer2 ?? []).join(""), "added");
    }
  }
  return segments;
}

/** Whether two lines share enough of their words to be one line rewritten. */
function alike(before: string, after: string): boolean {
  const a = before.match(EDIT_TOKEN)?.filter((token) => token.trim()) ?? [];
  const b = after.match(EDIT_TOKEN)?.filter((token) => token.trim()) ?? [];
  if (!a.length || !b.length) return false;
  if (a.length > EDIT_TOKENS || b.length > EDIT_TOKENS) return false;
  const kept = diffComm(a, b).reduce((count, part) => count + (part.common?.length ?? 0), 0);
  // Measured against the shorter line, so a line grown well past what it said still reads as rewritten.
  return kept / Math.min(a.length, b.length) >= 0.5;
}

/** A markdown line as words: a heading's text too, and nothing for a fence or a rule. */
function shownLine(line: string): string {
  const heading = HEADING.exec(line);
  return heading ? headingText(heading[2]!) : /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line) ? "" : plainPageLine(line);
}

/**
 * What changed from `before` to `after`, line by line as a reader sees it (see `PageEditGlimpse`), in the order
 * of the page. A line rewritten in place is one glimpse with its words marked; lines only added or only taken out
 * are glimpses of their own. Lines that only changed syntax, and code, are left out.
 */
export function pageEditGlimpses(before: string, after: string): PageEditGlimpse[] {
  const prose = (text: string) => [...markdownLines(text)];
  const oldLines = prose(before);
  const newLines = prose(after);
  const oldBlocks = pageBlocks(before);
  const newBlocks = pageBlocks(after);
  const sectionAt = (blocks: PageBlock[], offset: number) => {
    let found: PageBlock | undefined;
    for (const block of blocks) if (block.start <= offset) found = block;
    return found ? { blockId: found.id, section: found.title } : { blockId: "", section: "" };
  };
  const glimpses: PageEditGlimpse[] = [];
  for (const hunk of diffIndices(lines(before), lines(after))) {
    const [oldStart, oldLength] = hunk.buffer1;
    const [newStart, newLength] = hunk.buffer2;
    const shown = (line: { line: string; offset: number }) => ({ ...line, text: shownLine(line.line),
      heading: HEADING.test(line.line) });
    const taken = oldLines.slice(oldStart, oldStart + oldLength).filter((line) => line.prose).map(shown)
      .filter((line) => line.text);
    const added = newLines.slice(newStart, newStart + newLength).filter((line) => line.prose).map(shown)
      .filter((line) => line.text);
    // A line is rewritten in place only by a line like it: otherwise one went and another came.
    const pairs = new Map<number, (typeof taken)[number]>();
    let from = 0;
    for (const was of taken) {
      const index = added.findIndex((now, at) => at >= from && !pairs.has(at) && now.heading === was.heading
        && alike(was.text, now.text));
      if (index < 0) continue;
      pairs.set(index, was);
      from = index + 1;
    }
    const paired = new Set(pairs.values());
    for (const was of taken) {
      if (paired.has(was)) continue;
      glimpses.push({ ...sectionAt(oldBlocks, was.offset), kind: "removed", segments: [{ text: was.text, change: "removed" }] });
    }
    added.forEach((now, index) => {
      const was = pairs.get(index);
      // A new section is named by the lines under it.
      if (was?.text === now.text || (!was && now.heading)) return;
      glimpses.push(was ? { ...sectionAt(newBlocks, now.offset), kind: "changed", segments: lineSegments(was.text, now.text) }
        : { ...sectionAt(newBlocks, now.offset), kind: "added", segments: [{ text: now.text, change: "added" }] });
    });
  }
  return glimpses;
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
    else if (/[\p{L}\p{N}]/u.test(rest.replace(/^\s*\d+[.)]/u, ""))) lines.push(trimEnd(rest, " \t"));
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

/**
 * The link scheme of an image or video pasted into a page:
 * `xmatrix:page-media/<sha-256>.<extension>`, written as a markdown image. The
 * bytes are the Space's own private content; the page holds only the
 * reference, which the Hub serves to whoever can read the page.
 */
export const PAGE_MEDIA_SCHEME = "xmatrix:page-media/";

/** What a page shows inline, by the extension its reference carries. Never markup (no SVG). */
export const PAGE_MEDIA_TYPES = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
} as const;

export type PageMediaExtension = keyof typeof PAGE_MEDIA_TYPES;

export interface PageMedia {
  /** `<sha-256>.<extension>`, what the reference ends with. */
  file: string;
  contentHash: string;
  mimeType: (typeof PAGE_MEDIA_TYPES)[PageMediaExtension];
  video: boolean;
}

const PAGE_MEDIA_FILE = /^([0-9a-f]{64})\.([a-z0-9]{2,5})$/u;
const PAGE_MEDIA_REFERENCE = /xmatrix:page-media\/([0-9a-f]{64}\.[a-z0-9]{2,5})/gu;

/** The media a `<sha-256>.<extension>` file name names; null when the type is not shown in pages. */
export function pageMediaFile(file: string): PageMedia | null {
  const match = PAGE_MEDIA_FILE.exec(file);
  const extension = match?.[2];
  if (!match || !extension || !Object.hasOwn(PAGE_MEDIA_TYPES, extension)) return null;
  const mimeType = PAGE_MEDIA_TYPES[extension as PageMediaExtension];
  return { file, contentHash: match[1]!, mimeType, video: mimeType.startsWith("video/") };
}

/** The media a page reference (`xmatrix:page-media/…`) names; null for any other source. */
export function parsePageMedia(src: string): PageMedia | null {
  return src.startsWith(PAGE_MEDIA_SCHEME) ? pageMediaFile(src.slice(PAGE_MEDIA_SCHEME.length)) : null;
}

/** The reference for content of a type pages show; null for any other type. */
export function pageMediaReference(contentHash: string, mimeType: string): string | null {
  const type = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = (Object.keys(PAGE_MEDIA_TYPES) as PageMediaExtension[])
    .find((key) => PAGE_MEDIA_TYPES[key] === type);
  return extension && /^[0-9a-f]{64}$/u.test(contentHash) ? `${PAGE_MEDIA_SCHEME}${contentHash}.${extension}` : null;
}

/** Each media file (`<sha-256>.<extension>`) the page's text references. */
export function pageMediaReferences(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(PAGE_MEDIA_REFERENCE)].map((match) => match[1]!))]
    .filter((file) => pageMediaFile(file) !== null);
}

/**
 * The content reference that keeps a pasted file as the page's media: one per
 * page and file, so pasting the same file again reuses it.
 */
export const PAGE_MEDIA_OWNER_KIND = "page_media";

export function pageMediaRefId(pageId: string, contentHash: string): string {
  return `page-media:${pageId}:${contentHash}`;
}
