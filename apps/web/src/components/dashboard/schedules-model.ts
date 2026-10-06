import type { SerializedAutomation } from "@xmatrix/protocol";

/**
 * The Space's Schedules are an index of its Automations, not where they are
 * made (docs/design/pages-live-document.md §6). Every one keeps a page
 * section true, and its page is named on its row; the index itself reads by
 * what each one is doing: what needs a person, what runs next, what rests.
 */
export type ScheduleState = "attention" | "running" | "paused";

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
  const order: ScheduleState[] = ["attention", "running", "paused"];
  const groups = order.map((state): ScheduleGroup => ({ state, automations: [] }));
  for (const automation of automations) {
    groups[order.indexOf(scheduleState(automation, executionEnabled))]!.automations.push(automation);
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

function nextRunTime(automation: SerializedAutomation): number {
  const time = Date.parse(automation.nextRunAt);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/** A section's id is its heading's slug; until the page is read, the slug stands in for its title. */
export function sectionFallbackTitle(blockId: string): string {
  const words = blockId.replace(/-/gu, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Top of the page";
}
