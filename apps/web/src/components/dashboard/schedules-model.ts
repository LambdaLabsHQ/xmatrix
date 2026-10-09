import type { SerializedAutomation } from "@xmatrix/protocol";

/**
 * The Space's Schedules are an index of its Automations, not where they are
 * made (docs/design/pages-live-document.md §6). Every one keeps a page
 * section true, so the Schedules list is the page tree, each row saying what
 * its Automation is doing; Status groups the same rows by what they are
 * doing: what needs a person, what runs next, what rests.
 */
export type ScheduleState = "attention" | "running" | "paused";

/** Attention first: the order a person reads them in. */
export const SCHEDULE_STATES: readonly ScheduleState[] = ["attention", "running", "paused"];

export interface ScheduleGroup {
  state: ScheduleState;
  automations: SerializedAutomation[];
}

export interface ScheduleSummary {
  total: number;
  running: number;
  paused: number;
  attention: number;
  pages: number;
  /** The running Automation that runs soonest. */
  next?: SerializedAutomation;
}

/** Why a person should look at an Automation now, or null when nothing is wrong. */
export function scheduleAttention(automation: SerializedAutomation, executionEnabled: boolean | null): string | null {
  if (automation.detachedAt) return "Paused: its reference left the page";
  if (automation.latestExecution?.status === "failed") {
    const reason = automation.latestExecution.errorMessage || automation.latestExecution.errorCode;
    return reason ? `Its last run did not start: ${reason}` : "Its last run did not start";
  }
  if (automation.lastError) return `Its last run failed: ${automation.lastError}`;
  if (automation.enabled && executionEnabled === false) return "Scheduled runs are unavailable";
  return null;
}

export function scheduleRunning(automation: SerializedAutomation): boolean {
  return automation.enabled && !automation.detachedAt;
}

export function scheduleState(automation: SerializedAutomation, executionEnabled: boolean | null): ScheduleState {
  return scheduleAttention(automation, executionEnabled) ? "attention" : scheduleRunning(automation) ? "running" : "paused";
}

export function scheduleSummary(automations: readonly SerializedAutomation[],
  executionEnabled: boolean | null): ScheduleSummary {
  let next: SerializedAutomation | undefined;
  let running = 0;
  let attention = 0;
  const pages = new Set<string>();
  for (const automation of automations) {
    if (automation.pageId) pages.add(automation.pageId);
    if (scheduleAttention(automation, executionEnabled)) attention += 1;
    if (!scheduleRunning(automation)) continue;
    running += 1;
    if (!next || nextRunTime(automation) < nextRunTime(next)) next = automation;
  }
  return { total: automations.length, running, paused: automations.length - running, attention, pages: pages.size,
    next };
}

/**
 * What needs a person first, then what runs, soonest first, then what is
 * paused, by name. A state with nothing in it is left out.
 */
export function groupSchedules(automations: readonly SerializedAutomation[],
  executionEnabled: boolean | null): ScheduleGroup[] {
  const groups = SCHEDULE_STATES.map((state): ScheduleGroup => ({ state, automations: [] }));
  for (const automation of automations) {
    groups[SCHEDULE_STATES.indexOf(scheduleState(automation, executionEnabled))]!.automations.push(automation);
  }
  for (const group of groups) group.automations.sort(compareSchedules);
  return groups.filter((group) => group.automations.length > 0);
}

function compareSchedules(left: SerializedAutomation, right: SerializedAutomation): number {
  const running = Number(scheduleRunning(right)) - Number(scheduleRunning(left));
  if (running) return running;
  if (scheduleRunning(left)) {
    const soonest = nextRunTime(left) - nextRunTime(right);
    if (soonest) return soonest;
  }
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id);
}

/** A page in the Schedules tree: its own Automations, then the pages under it that hold some. */
export interface SchedulePageNode {
  kind: "page";
  pageId: string;
  /** Null when the reader cannot see the page in the tree. */
  title: string | null;
  automations: SerializedAutomation[];
  children: SchedulePageNode[];
  /** What runs in this page and every page under it. */
  counts: ScheduleCounts;
}

export type ScheduleCounts = Record<ScheduleState, number>;

/** Automations made in a conversation rather than on a page, under that conversation. */
export interface ScheduleConversationNode {
  kind: "conversation";
  channelId: string;
  automations: SerializedAutomation[];
  counts: ScheduleCounts;
}

/** What the tree needs of a page. */
export interface TreePage {
  pageId: string;
  title: string;
}

export type ScheduleTreeNode = SchedulePageNode | ScheduleConversationNode;

/**
 * The Space's Automations on its page tree: only the pages that hold one, and
 * the pages above them, in the tree's order (`childrenOf`: each parent's
 * pages in sibling order, the top level under null). A page's Automations
 * follow its sections from the top (`sectionOrder`: a read page's section
 * ids). A page the reader cannot place sits at the top level. Automations
 * kept in a conversation follow the pages, one node per conversation.
 */
export function scheduleTree(automations: readonly SerializedAutomation[],
  childrenOf: ReadonlyMap<string | null, readonly TreePage[]>, sectionOrder: (pageId: string) => readonly string[],
  executionEnabled: boolean | null): ScheduleTreeNode[] {
  const byPage = new Map<string, SerializedAutomation[]>();
  const byConversation = new Map<string, SerializedAutomation[]>();
  for (const automation of automations) {
    const [map, key] = automation.pageId ? [byPage, automation.pageId] : [byConversation, automation.channelId];
    map.set(key, [...map.get(key) ?? [], automation]);
  }
  const build = (page: TreePage | { pageId: string; title: null }): SchedulePageNode | null => {
    const children = (childrenOf.get(page.pageId) ?? []).flatMap((child) => build(child) ?? []);
    const own = bySection(byPage.get(page.pageId) ?? [], sectionOrder(page.pageId));
    if (own.length === 0 && children.length === 0) return null;
    const counts = countStates(own, executionEnabled);
    for (const child of children) {
      for (const state of SCHEDULE_STATES) counts[state] += child.counts[state];
    }
    return { kind: "page", pageId: page.pageId, title: page.title, automations: own, children, counts };
  };
  const known = new Set([...childrenOf.values()].flat().map((page) => page.pageId));
  const roots = (childrenOf.get(null) ?? []).flatMap((page) => build(page) ?? []);
  const unplaced = [...byPage.keys()].filter((pageId) => !known.has(pageId))
    .flatMap((pageId) => build({ pageId, title: null }) ?? []);
  const conversations = [...byConversation].map(([channelId, list]): ScheduleConversationNode =>
    ({ kind: "conversation", channelId, automations: bySection(list, []), counts: countStates(list, executionEnabled) }));
  return [...roots, ...unplaced, ...conversations];
}

function countStates(automations: readonly SerializedAutomation[], executionEnabled: boolean | null): ScheduleCounts {
  const counts: ScheduleCounts = { attention: 0, running: 0, paused: 0 };
  for (const automation of automations) counts[scheduleState(automation, executionEnabled)] += 1;
  return counts;
}

/** In the order of the sections they keep, top first; then by name. */
function bySection(automations: readonly SerializedAutomation[], sections: readonly string[]): SerializedAutomation[] {
  const at = (automation: SerializedAutomation) => {
    const index = automation.blockId === undefined ? -1 : sections.indexOf(automation.blockId);
    return index < 0 ? sections.length : index;
  };
  return [...automations].sort((left, right) => at(left) - at(right) ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id));
}

function nextRunTime(automation: SerializedAutomation): number {
  const time = Date.parse(automation.nextRunAt);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/** A section's id is its heading's slug; until the page is read, the slug stands in for its title. */
export function sectionFallbackTitle(blockId: string): string {
  const words = blockId.replace(/-/gu, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Top of the page";
}
