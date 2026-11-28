import type { PageOverview, PageResult } from "@xmatrix/protocol";

/**
 * The Overview (docs/design/pages-overview.md) as its view reads it: what a
 * reader has to handle, and what happened in the range they look at. Kept
 * apart from the view so it can be checked without drawing anything.
 */

/** The Overview's place among a Space's pages: opened and linked as a page is, but it is not one. */
export const OVERVIEW_PAGE_ID = "overview";
export const OVERVIEW_TITLE = "Overview";

export type OverviewRange = "away" | "today" | "yesterday" | "week";
export const OVERVIEW_RANGES: readonly OverviewRange[] = ["away", "today", "yesterday", "week"];
export const OVERVIEW_RANGE_LABEL: Record<OverviewRange, string> = {
  away: "While you were away", today: "Today", yesterday: "Yesterday", week: "This week",
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** As far back as the Hub keeps results for the Overview. */
const WEEK_MS = 7 * DAY_MS;

/**
 * The stretch of time a range names, in the reader's own day: `away` begins
 * where they last saw the results (a week back before their first look) and
 * every range but yesterday runs to now.
 */
export function overviewSpan(range: OverviewRange, now: Date, seenAt: string | null): { from: number; to: number } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === "today") return { from: midnight, to: Infinity };
  if (range === "yesterday") return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime(), to: midnight };
  const week = now.getTime() - WEEK_MS;
  const seen = range === "away" && seenAt ? Date.parse(seenAt) : Number.NaN;
  return { from: Number.isFinite(seen) ? Math.max(seen, week) : week, to: Infinity };
}

export const resultKey = (result: Pick<PageResult, "pageId" | "revision">) => `${result.pageId}:${result.revision}`;

export interface OverviewLists {
  /** Problems the reader has neither answered nor checked off, whenever in the week they came. */
  problems: PageResult[];
  /** Problems they answered, with the conversation they answered in: the answer comes back there. */
  moving: Array<{ result: PageResult; conversationId: string }>;
  /** Everything else that happened in the range. */
  happened: PageResult[];
}

/**
 * The reader's results as the Overview lists them, each newest first. A problem waits until it is
 * handled, so it is listed outside the range too; what merely happened is listed for the range only.
 */
export function overviewLists(overview: PageOverview, range: OverviewRange, now: Date): OverviewLists {
  const handled = new Map(overview.handled.map((mark) => [resultKey(mark), mark]));
  const { from, to } = overviewSpan(range, now, overview.seenAt);
  const lists: OverviewLists = { problems: [], moving: [], happened: [] };
  for (const result of overview.results) {
    const mark = handled.get(resultKey(result));
    if (result.kind === "problem") {
      if (!mark) lists.problems.push(result);
      else if (mark.conversationId) lists.moving.push({ result, conversationId: mark.conversationId });
      continue;
    }
    const at = Date.parse(result.createdAt);
    if (at > from && at < to) lists.happened.push(result);
  }
  return lists;
}

/**
 * How far the reader has now seen, once they leave: the newest of the results they were shown, when
 * that is past where they stood. Null when they were shown nothing newer.
 */
export function overviewSeenThrough(seenAt: string | null, shown: readonly Pick<PageResult, "createdAt">[]): string | null {
  let newest = seenAt ? Date.parse(seenAt) : Number.NEGATIVE_INFINITY;
  let through: string | null = null;
  for (const result of shown) {
    const at = Date.parse(result.createdAt);
    if (at > newest) { newest = at; through = result.createdAt; }
  }
  return through;
}

/** Something the reader handled on this visit: the item as it stood, and the key of the one it followed. */
export interface OverviewHandled<Item> { item: Item; after: string | null }

/**
 * A list as its reader works through it: what it holds now, with what they handled on this visit kept
 * where it stood after the list itself let it go. Nothing moves from under their hands.
 */
export function overviewKept<Item>(current: readonly Item[], keyOf: (item: Item) => string,
  handled: ReadonlyMap<string, OverviewHandled<Item>>): Item[] {
  const kept = [...current];
  for (const [key, { item, after }] of handled) {
    if (kept.some((other) => keyOf(other) === key)) continue;
    kept.splice(after === null ? 0 : kept.findIndex((other) => keyOf(other) === after) + 1, 0, item);
  }
  return kept;
}

/** A conversation whose declared wait is on the reader, as the conversation list knows it. */
export interface OverviewWaitSource {
  id: string;
  attention?: { unreadAttentionCount?: number; lastMessageId?: string } | null;
}

/**
 * The conversations that wait on the reader apart from the requests already listed: a request's card
 * is itself a wait in its conversation, and is not listed twice.
 */
export function overviewWaits<Channel extends OverviewWaitSource>(channels: readonly Channel[],
  requests: ReadonlyArray<{ channelId: string; messageId: string }>): Channel[] {
  return channels.filter((channel) => {
    const waiting = channel.attention?.unreadAttentionCount ?? 0;
    if (waiting <= 0) return false;
    const cards = requests.filter((request) => request.channelId === channel.id);
    return waiting > cards.length || !cards.some((card) => card.messageId === channel.attention?.lastMessageId);
  });
}

/** Changes whenever what waits on the reader in these conversations does: the list of their requests is read again then. */
export function overviewAttentionKey(channels: readonly OverviewWaitSource[]): string {
  return channels.filter((channel) => (channel.attention?.unreadAttentionCount ?? 0) > 0)
    .map((channel) => `${channel.id}:${channel.attention?.unreadAttentionCount}:${channel.attention?.lastMessageId ?? ""}`).join("|");
}

/** The Agent that made a change, as it is addressed (`claude:4`), when one did. */
export function resultAgent(result: Pick<PageResult, "authors">): string | null {
  return result.authors.find((author) => author.kind === "agent")?.label ?? null;
}

/**
 * Changes whenever a page's head or its summary does. A result is written with its page's summary,
 * so the Overview is read again then: it rides the tree's refresh and has no clock of its own.
 */
export function overviewTreeKey(pages: ReadonlyArray<{ headRevision: number; summary?: { revision: number } | null }>): string {
  let heads = 0;
  let summaries = 0;
  for (const page of pages) {
    heads += page.headRevision;
    summaries += page.summary?.revision ?? 0;
  }
  return `${pages.length}:${heads}:${summaries}`;
}
