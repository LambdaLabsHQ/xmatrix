import {
  channelReferenceToken,
  pageReferenceToken,
  type PageSummary,
  type SerializedChannel,
} from "@xmatrix/protocol";

/**
 * Typing a reference (pages-and-conversations.md §4.3): `#` picks a channel,
 * `[[` picks a page, and `[[page#section` one of its sections. `【【` and `＃`
 * are the same triggers as a Chinese input method types them. The draft shows
 * the name; the message carries `channel:<id>` / `page:<id>#<section>`.
 */
export type ActiveReference =
  | { kind: "channel"; start: number; end: number; query: string }
  | { kind: "page"; start: number; end: number; query: string; section: string | null };

const PAGE_OPENERS = ["[[", "【【"] as const;
const MAX_PAGE_QUERY = 80;

/** The reference being typed at the caret, if any. */
export function findActiveReference(draft: string, cursor: number): ActiveReference | null {
  if (cursor < 0 || cursor > draft.length) return null;
  const line = draft.slice(draft.lastIndexOf("\n", cursor - 1) + 1, cursor);
  const lineStart = cursor - line.length;

  const opener = Math.max(...PAGE_OPENERS.map((token) => line.lastIndexOf(token)));
  if (opener >= 0) {
    const typed = line.slice(opener + 2);
    if (!/[\]】]/u.test(typed) && typed.length <= MAX_PAGE_QUERY && !/^\s/u.test(typed)) {
      const hash = typed.search(/[#＃]/u);
      return {
        kind: "page", start: lineStart + opener, end: cursor,
        query: (hash < 0 ? typed : typed.slice(0, hash)).trim(),
        section: hash < 0 ? null : typed.slice(hash + 1).trim(),
      };
    }
  }

  // Chinese text runs straight into `＃` with no space; Latin words and URL fragments do not.
  const match = /(^|[^A-Za-z0-9_&/#＃:])([#＃])([^\s#＃]*)$/u.exec(line);
  if (!match) return null;
  const query = match[3]!;
  // `#3484` names a pull request or issue, not a channel.
  if (/^\p{N}/u.test(query)) return null;
  const start = lineStart + match.index + match[1]!.length;
  return { kind: "channel", start, end: cursor, query };
}

function rank(label: string, query: string): number {
  const text = label.toLowerCase();
  const wanted = query.toLowerCase();
  if (!wanted) return 1;
  if (text === wanted) return 4;
  if (text.startsWith(wanted)) return 3;
  if (text.split(/[\s\-_/·]+/u).some((word) => word.startsWith(wanted))) return 2;
  return text.includes(wanted) ? 1 : 0;
}

function byRank<T>(items: readonly T[], label: (item: T) => string, query: string, limit: number): T[] {
  return items
    .map((item, index) => ({ item, index, score: rank(label(item), query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export type ReferenceCandidate =
  | { kind: "channel"; id: string; label: string; detail: string; channelId: string }
  | { kind: "page"; id: string; label: string; detail: string; pageId: string; blockId: string | null };

export function channelReferenceCandidates(channels: readonly SerializedChannel[], query: string,
  spaceId: string | null, currentChannelId: string | null): ReferenceCandidate[] {
  const pool = channels.filter((channel) => (!spaceId || channel.spaceId === spaceId) && channel.name?.trim());
  // The conversation being written in is the least likely one to point at.
  const ordered = [...pool.filter((channel) => channel.id !== currentChannelId),
    ...pool.filter((channel) => channel.id === currentChannelId)];
  return byRank(ordered, (channel) => channelLabel(channel), query, 8).map((channel) => ({
    kind: "channel", id: `channel:${channel.id}`, label: channelLabel(channel),
    detail: channel.topic?.trim() || channel.summary?.trim().split("\n")[0] || "", channelId: channel.id,
  }));
}

export function pageReferenceCandidates(pages: readonly PageSummary[], query: string): ReferenceCandidate[] {
  const titles = new Map(pages.map((page) => [page.pageId, page.title.trim() || "Untitled"]));
  return byRank(pages, (page) => titles.get(page.pageId)!, query, 8).map((page) => ({
    kind: "page", id: `page:${page.pageId}`, label: titles.get(page.pageId)!,
    detail: page.parentPageId ? titles.get(page.parentPageId) ?? "" : "", pageId: page.pageId, blockId: null,
  }));
}

/** The page itself, then its sections, for `[[page#section`. */
export function sectionReferenceCandidates(page: { pageId: string; title: string },
  blocks: ReadonlyArray<{ id: string; title: string; depth: number }>, query: string): ReferenceCandidate[] {
  const title = page.title.trim() || "Untitled";
  const sections = byRank(blocks.filter((block) => block.id), (block) => block.title, query, 12);
  return [
    ...(query ? [] : [{ kind: "page" as const, id: `page:${page.pageId}`, label: title, detail: "Whole page",
      pageId: page.pageId, blockId: null }]),
    ...sections.map((block) => ({
      kind: "page" as const, id: `page:${page.pageId}#${block.id}`, label: block.title, detail: title,
      pageId: page.pageId, blockId: block.id,
    })),
  ];
}

export function channelLabel(channel: Pick<SerializedChannel, "name" | "id">): string {
  return (channel.name || channel.id.slice(0, 10)).replace(/^#/u, "");
}

/** What the draft shows for a picked reference, and the token the message carries for it. */
export function referenceInsertion(candidate: ReferenceCandidate, pageTitle?: string): { text: string; token: string } {
  if (candidate.kind === "channel") {
    return { text: `#${candidate.label}`, token: channelReferenceToken(candidate.channelId) };
  }
  const label = candidate.blockId ? `${pageTitle?.trim() || "Untitled"}#${candidate.label}` : candidate.label;
  return { text: `[[${label}]]`, token: pageReferenceToken(candidate.pageId, candidate.blockId) };
}

/** Replace the typed trigger with the picked reference and a trailing space. */
export function completeReference(draft: string, active: ActiveReference, text: string): {
  value: string; cursor: number; start: number; end: number;
} {
  // A page reference typed inside `[[…]]` absorbs the closing brackets already there.
  const tail = draft.slice(active.end);
  const closing = active.kind === "page" ? /^\s*(\]\]|】】)/u.exec(tail)?.[0].length ?? 0 : 0;
  const after = draft.slice(active.end + closing);
  const spacer = /^\s/u.test(after) ? "" : " ";
  const value = draft.slice(0, active.start) + text + spacer + after;
  return { value, cursor: active.start + text.length + spacer.length, start: active.start,
    end: active.start + text.length };
}
