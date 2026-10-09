import { channelActivityOf, type ChannelActivity } from "@xmatrix/protocol";
import type { TimelineItem } from "./workspace-shell-message-model";

/**
 * How a conversation reads (docs/design/conversation-activity.md §4.1).
 *
 * Talk stays whole. Activity entries, and reports the Hub judged superseded,
 * fold into one row per run of the same Instance; anything from anyone else
 * ends the run, so who did what in which order stays visible. A message that
 * directly follows its sender's own message drops the repeated header.
 */

/** Messages from one sender this close together read as one turn of talk. */
export const CONTINUATION_WINDOW_MS = 10 * 60 * 1000;

export function timelineItemActivity(item: TimelineItem): ChannelActivity | undefined {
  return channelActivityOf(item.metadata);
}

/** The narrowest sender identity: two Instances of one Agent are different work. */
function actorKey(item: TimelineItem): string | undefined {
  if (!item.senderId) return undefined;
  return item.senderKind === "agent"
    ? `${item.senderId}#${item.senderInstanceId ?? ""}`
    : `${item.senderKind ?? "user"}:${item.senderId}`;
}

function foldable(item: TimelineItem): boolean {
  if (!item.messageId || item.recalledAt || item.sendStatus || item.isEvent) return false;
  return Boolean(item.supersededBy) || Boolean(timelineItemActivity(item));
}

/**
 * The header tags a message carries, by the key its tag is drawn with. Model
 * and effort share one tag in the header, so a change to either is the model's.
 */
function headerTags(item: TimelineItem): Map<string, string> {
  const tags = new Map<string, string>([
    ["branch", item.senderGitBranch ?? ""],
    ["owner", item.senderOwnerLabel ?? ""],
    ["machine", [item.senderMachineLabel, item.senderMachineId, item.senderMachineOwnerUserId].join("|")],
    ["stale", item.senderInstanceStale ? "1" : ""],
    ["goal", `${item.senderGoal?.objective ?? ""}|${item.senderGoal?.status ?? ""}`],
  ]);
  for (const chip of item.senderStatusChips ?? []) {
    const id = chip.id.toLowerCase();
    const key = id === "effort" ? "model" : id;
    tags.set(key, `${tags.get(key) ?? ""}|${id}=${chip.value ?? ""}`);
  }
  return tags;
}

/** Keys of the tags that differ between two messages, sorted. */
function changedTags(previous: TimelineItem, next: TimelineItem): string[] {
  const before = headerTags(previous);
  const after = headerTags(next);
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => (before.get(key) ?? "") !== (after.get(key) ?? "")).sort();
}

/** Same sender moments later on the same day: everything continuation asks but the tags. */
function sameTurn(previous: TimelineItem, item: TimelineItem): boolean {
  if (previous.isEvent || item.isEvent) return false;
  // A provenance badge or a link origin is part of what the reader must see.
  if (item.provenance || item.linkOrigin || item.reservedSystemAgent || previous.reservedSystemAgent) {
    return false;
  }
  const key = actorKey(item);
  if (!key || key !== actorKey(previous)) return false;
  const gap = Date.parse(item.sentAt) - Date.parse(previous.sentAt);
  if (!Number.isFinite(gap) || gap < 0 || gap > CONTINUATION_WINDOW_MS) return false;
  // The timeline has no day dividers: a header's timestamp is what says a new
  // day began, so a turn that crosses local midnight starts a new header.
  return new Date(item.sentAt).toDateString() === new Date(previous.sentAt).toDateString();
}

/** Whether a message can drop its avatar and header under the row above. */
export function continuesPrevious(previous: TimelineItem | undefined, item: TimelineItem): boolean {
  if (!previous || previous.folded) return false;
  return sameTurn(previous, item) && changedTags(previous, item).length === 0;
}

/**
 * The tags that brought a header back within one sender's turn: the previous
 * message of the same Instance, past any fold of its own activity, is moments
 * old, but a tag changed. The header names what changed so it is not read as
 * a repeat: only the changed tags, each as its old value → new value (user
 * 2026-10-09: 签变了能否有个更好的 UX 提示 / 搞个箭头那种，其他的签没必要显示).
 */
export function retaggedFrom(
  rows: readonly TimelineItem[],
  item: TimelineItem,
): { keys: string[]; previous: TimelineItem } | undefined {
  let index = rows.length - 1;
  while (index >= 0 && rows[index]!.folded && actorKey(rows[index]!) === actorKey(item)) index -= 1;
  const previous = rows[index];
  if (!previous || previous.folded || !sameTurn(previous, item)) return undefined;
  const keys = changedTags(previous, item);
  return keys.length > 0 ? { keys, previous } : undefined;
}

function foldRow(items: TimelineItem[]): TimelineItem {
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const sequences = items
    .map((item) => item.sequence)
    .filter((sequence): sequence is number => typeof sequence === "number" && Number.isFinite(sequence));
  return {
    // Keyed by the run's first entry, so appending to it keeps the row.
    id: `fold:${first.id}`,
    channelId: first.channelId,
    ...(sequences.length > 0 ? { sequence: Math.max(...sequences) } : {}),
    author: last.author,
    body: foldSummary(items).segments.join(" · "),
    sentAt: first.sentAt,
    avatarUrl: last.avatarUrl,
    own: last.own,
    senderKind: last.senderKind,
    senderId: last.senderId,
    senderInstanceId: last.senderInstanceId,
    senderStatus: last.senderStatus,
    senderInstanceStale: last.senderInstanceStale,
    folded: items,
  };
}

/**
 * Rows for the timeline, in order. `timeline` is ordered oldest first; the
 * rows keep that order, a fold standing where its first entry stood.
 */
export function buildConversationRows(
  timeline: readonly TimelineItem[],
  /** Judgments that arrived after their messages were loaded, by message id. */
  supersessions?: ReadonlyMap<string, string>,
): TimelineItem[] {
  const rows: TimelineItem[] = [];
  let run: TimelineItem[] = [];
  const flush = () => {
    if (run.length > 0) rows.push(foldRow(run));
    run = [];
  };
  for (const loaded of timeline) {
    const judged = loaded.messageId && !loaded.supersededBy ? supersessions?.get(loaded.messageId) : undefined;
    const item = judged ? { ...loaded, supersededBy: judged } : loaded;
    if (foldable(item)) {
      if (run.length > 0 && actorKey(run[0]!) !== actorKey(item)) flush();
      run.push(item);
      continue;
    }
    flush();
    const previous = rows[rows.length - 1];
    if (continuesPrevious(previous, item)) {
      rows.push({ ...item, continuation: true });
      continue;
    }
    const retagged = retaggedFrom(rows, item);
    rows.push(retagged ? { ...item, retagged } : item);
  }
  flush();
  return rows;
}

export type FoldSummary = {
  /** One segment per fact, oldest first: `✓ step`, `↗ owner/repo#1`, `“report…”`. */
  segments: string[];
  steps: number;
  reports: number;
  pullRequests: { repository: string; number: number; url: string }[];
  /** The step in progress at the fold's newest plan entry. */
  inProgress?: string;
};

function firstLine(body: string): string {
  const line = body.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function foldSummary(items: readonly TimelineItem[]): FoldSummary {
  const summary: FoldSummary = { segments: [], steps: 0, reports: 0, pullRequests: [] };
  for (const item of items) {
    const activity = timelineItemActivity(item);
    if (!activity) {
      summary.reports += 1;
      summary.segments.push(`“${firstLine(item.body)}”`);
      continue;
    }
    if (activity.kind === "pull_request") {
      summary.pullRequests.push({ repository: activity.repository, number: activity.number, url: activity.url });
      summary.segments.push(`↗ ${activity.repository}#${activity.number}`);
      continue;
    }
    summary.steps += activity.completed.length;
    summary.segments.push(...activity.completed.map((step) => `✓ ${step}`));
    summary.inProgress = activity.inProgress;
    if (activity.completed.length === 0 && !activity.inProgress) {
      summary.segments.push(`Plan · ${activity.steps.length} step${activity.steps.length === 1 ? "" : "s"}`);
    }
  }
  return summary;
}

function rowMaxSequence(row: TimelineItem): number {
  const values = (row.folded ?? [row])
    .map((item) => item.sequence)
    .filter((sequence): sequence is number => typeof sequence === "number" && Number.isFinite(sequence));
  return values.length > 0 ? Math.max(...values) : 0;
}

export type SinceDigest = {
  /** Index of the first row with anything unread. */
  index: number;
  messages: number;
  mentions: number;
  folded: number;
  pullRequests: string[];
  people: string[];
};

/**
 * What happened after the reader's position, for the divider above it
 * (docs/design/conversation-activity.md §3.5). Derived from the typed entries;
 * nothing here is written by a model. Undefined when nothing is unread.
 */
export function sinceDigest(
  rows: readonly TimelineItem[],
  readSequence: number | undefined,
  viewerIdentityId: string,
): SinceDigest | undefined {
  if (readSequence === undefined || !Number.isFinite(readSequence)) return undefined;
  const index = rows.findIndex((row) => rowMaxSequence(row) > readSequence && !row.own);
  if (index < 0) return undefined;
  const digest: SinceDigest = { index, messages: 0, mentions: 0, folded: 0, pullRequests: [], people: [] };
  const people = new Set<string>();
  for (const row of rows.slice(index)) {
    if (row.own) continue;
    people.add(row.author);
    if (row.folded) {
      const items = row.folded.filter((item) => (item.sequence ?? 0) > readSequence);
      digest.folded += items.length;
      for (const pr of foldSummary(items).pullRequests) digest.pullRequests.push(`${pr.repository}#${pr.number}`);
      continue;
    }
    digest.messages += 1;
    if (row.mentionReadStatuses?.some((status) => status.targetId === viewerIdentityId)) digest.mentions += 1;
  }
  digest.people = [...people];
  return digest;
}

export function sinceDigestLine(digest: SinceDigest): string {
  const parts = [
    digest.mentions > 0 ? `${digest.mentions} mention${digest.mentions === 1 ? "" : "s"} of you` : "",
    digest.messages > 0 ? `${digest.messages} message${digest.messages === 1 ? "" : "s"}` : "",
    ...digest.pullRequests.map((pr) => `↗ ${pr}`),
    digest.folded > 0 ? `${digest.folded} update${digest.folded === 1 ? "" : "s"} folded` : "",
    digest.people.length > 0 ? `from ${digest.people.slice(0, 3).join(", ")}${digest.people.length > 3 ? " and others" : ""}` : "",
  ].filter(Boolean);
  return `Since you last read · ${parts.join(" · ")}`;
}
