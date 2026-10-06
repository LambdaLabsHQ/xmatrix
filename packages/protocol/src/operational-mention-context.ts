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
  children?: readonly Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
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
  const pending: Node[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (LITERAL_NODES.has(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start !== "number" || typeof end !== "number") {
        // A parser extension without source positions cannot authorize a call.
        return [{ start: 0, end: body.length }];
      }
      ranges.push({ start, end });
    } else if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]!);
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
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
