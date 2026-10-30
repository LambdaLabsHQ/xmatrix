import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { decodeString } from "micromark-util-decode-string";
import { createInstanceMentionScanner, existingInstanceMentionScanner, handoffInstanceMentionScanner, rebornInstanceMentionScanner } from "./agent-mention.js";

export interface NonOperationalMentionRange { start: number; end: number }

const LITERAL_NODES = new Set([
  "code", "inlineCode", "blockquote", "link", "linkReference", "image", "imageReference",
  "definition", "html", "delete", "footnoteDefinition", "footnoteReference",
]);

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: readonly Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function plainAutolinkText(node: Node): string | undefined {
  const text = node.children?.length === 1 && node.children[0]?.type === "text" ? node.children[0].value : undefined;
  if (node.type !== "link" || !text || !(
    (/^https?:\/\//iu.test(text) && node.url === text) ||
    (text.startsWith("www.") && node.url === `http://${text}`) || node.url === `mailto:${text}`
  )) return undefined;
  return text;
}

/** GFM can add unpositioned autolinks inside JSON. Recover offsets only when
 * all of the positioned ancestor's children reconstruct its source exactly;
 * a decoded link must never borrow an identical URL from somewhere else. */
function autolinkSourceRanges(body: string, source: Node): NonOperationalMentionRange[] | undefined {
  const start = source.position?.start.offset, end = source.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number" || !source.children) return undefined;
  const text = source.children.map(child => child.type === "text" ? child.value : plainAutolinkText(child));
  if (text.some(part => part === undefined) || text.join("") !== body.slice(start, end)) return undefined;
  const ranges: NonOperationalMentionRange[] = [];
  let offset = start;
  for (const [index, child] of source.children.entries()) {
    const end = offset + text[index]!.length;
    if (child.type === "link") ranges.push({ start: offset, end });
    offset = end;
  }
  return ranges;
}

/** Parse the same Markdown/GFM contexts as the message renderer. Offsets refer
 * to the original UTF-16 string; no rewriting of paths or message text occurs.
 * A quoted workspace argument can contain Markdown punctuation, so eligibility
 * is determined at the opening @, not by rewriting the complete match.
 */
export function nonOperationalMentionRanges(body: string): NonOperationalMentionRange[] {
  if (!body) return [];
  const root = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const ranges: NonOperationalMentionRange[] = [];
  const recoveredAutolinks = new Set<Node>();
  const pending: { node: Node; source: Node }[] = [{ node: root, source: root }];
  while (pending.length) {
    const { node, source } = pending.pop()!;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const positioned = typeof start === "number" && typeof end === "number";
    if (LITERAL_NODES.has(node.type)) {
      if (positioned) ranges.push({ start, end });
      else {
        if (node.type === "link" && source.children?.includes(node)) {
          if (recoveredAutolinks.has(source)) continue;
          const recovered = autolinkSourceRanges(body, source);
          if (recovered) { recoveredAutolinks.add(source); ranges.push(...recovered); continue; }
        }
        // Unmappable or other unpositioned literals still cannot authorize a call.
        return [{ start: 0, end: body.length }];
      }
    } else if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index--) {
        pending.push({ node: node.children[index]!, source: positioned ? node : source });
      }
    }
  }
  // Recovered occurrences can overlap positioned literals. Union them so the
  // last-starting range cannot expose the remainder of a longer exclusion.
  const merged: NonOperationalMentionRange[] = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function isOperationalMentionStart(start: number, ranges: readonly NonOperationalMentionRange[]): boolean {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.start <= start) low = middle + 1;
    else high = middle;
  }
  return low === 0 || start >= ranges[low - 1]!.end;
}

export function filterOperationalMentions<T extends { start: number }>(body: string, matches: readonly T[]): T[] {
  if (!matches.length) return [];
  const ranges = nonOperationalMentionRanges(body);
  return matches.filter(match => isOperationalMentionStart(match.start, ranges));
}

export function hasOperationalAgentInvocation(body: string): boolean {
  const candidates = [createInstanceMentionScanner(), rebornInstanceMentionScanner(), handoffInstanceMentionScanner(), existingInstanceMentionScanner()]
    .flatMap(scanner => [...body.matchAll(scanner)].map(match => ({
      start: match.index! + match[0].length - match[1]!.length - 1,
    })));
  return filterOperationalMentions(body, candidates).length > 0;
}

/** Map rendered literal @ signs back to the original Markdown text node.
 * Escapes and character references remain text, never invocation delimiters.
 * If a renderer transforms text in an unsupported way, return no guessed map.
 */
export function literalMentionSourceOffsets(raw: string, rendered: string): Map<number, number> | undefined {
  const positions = new Map<number, number>();
  if (!/[@＠]/u.test(rendered)) return positions;
  const reference = /&(?:#(?:[xX][0-9a-fA-F]{1,6}|\d{1,7})|[a-zA-Z0-9]{1,31});/y;
  const pieces: string[] = [];
  let renderedLength = 0;
  for (let index = 0; index < raw.length;) {
    let piece = raw[index]!;
    let length = 1;
    if (piece === "\\" && index + 1 < raw.length && /[!-/:-@[-`{-~]/u.test(raw[index + 1]!)) {
      piece = decodeString(raw.slice(index, index + 2)); length = 2;
    } else if (piece === "&") {
      reference.lastIndex = index;
      const match = reference.exec(raw);
      if (match) { piece = decodeString(match[0]); length = match[0].length; }
    } else if (piece === "\r") {
      piece = "\n"; length = raw[index + 1] === "\n" ? 2 : 1;
    } else if (piece === "\0") {
      piece = "\uFFFD";
    } else if (piece === "@" || piece === "＠") {
      positions.set(renderedLength, index);
    }
    pieces.push(piece); renderedLength += piece.length; index += length;
  }
  return pieces.join("") === rendered ? positions : undefined;
}
