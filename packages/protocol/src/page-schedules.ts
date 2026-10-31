import { automationTriggersFrom, type AutomationTrigger } from "./authority-foundation.js";
import {
  AUTOMATION_MAX_INTERVAL_MINUTES, AUTOMATION_MAX_ONCE_LEAD_MINUTES, AUTOMATION_MIN_INTERVAL_MINUTES,
} from "./automation-stored-values.js";
import { markdownLines, pageBlocks } from "./page-markdown.js";

/**
 * A page's schedules are lines of its text, written as Obsidian Tasks writes
 * a recurring or scheduled task (docs/design/pages-live-document.md §6.1):
 *
 *   - [ ] Audit the code for bloat; record it here 🔁 every 12 hours, on merged:acme/api@main
 *   - [ ] Remind @Yiming to renew the domain ⏳ 2026-11-03 09:00 +08:00
 *   - [x] Remind Daniel about the quarterly tax ⏳ 2026-10-30 09:00 +08:00 ✅ 2026-10-30
 *   - [-] Sweep Sentry 🔁 every week
 *
 * A task with 🔁 or ⏳ is a schedule; its description is the instruction each
 * occurrence posts. `[ ]` runs, `[-]` is paused, `[x]` is done. 🔁 takes a
 * cadence and, after commas, the events that also make it due; ⏳ alone runs
 * it once at that time, and with 🔁 sets when its first occurrence runs.
 * Nothing else stores what a schedule is: the page's head revision does.
 */

export const SCHEDULE_RECURRENCE = "🔁";
export const SCHEDULE_AT = "⏳";
export const SCHEDULE_DONE = "✅";

export type PageScheduleStatus = "running" | "paused" | "done";

export interface PageSchedule {
  /** The line as written, without its indent: what identifies it between revisions. */
  source: string;
  /** The section that holds it. */
  blockId: string;
  /** What each occurrence asks, the task's description. */
  instruction: string;
  status: PageScheduleStatus;
  /** Its cadence; absent for a one-time schedule. */
  intervalMinutes?: number;
  /** ⏳: a one-time schedule's time, or a recurring one's first occurrence, as UTC. */
  at?: string;
  triggers: AutomationTrigger[];
  /** ✅: the day it was done, as written. */
  doneOn?: string;
  /** Why the line is not a schedule that can run, in words naming what to fix. */
  error?: string;
  /** Offsets of the line in the page. */
  start: number;
  end: number;
}

const TASK = /^(\s*)[-*+]\s\[([ xX-])\]\s+(.*)$/u;
const SIGNIFIER = /[🔁⏳✅]/u;
const UNITS: Record<string, number> = {
  minute: 1, minutes: 1, min: 1, mins: 1, m: 1,
  hour: 60, hours: 60, hr: 60, hrs: 60, h: 60,
  day: 1440, days: 1440, d: 1440,
  week: 10080, weeks: 10080, w: 10080,
};

/** Every schedule written in the page, outside code, in order. */
export function pageSchedules(markdown: string): PageSchedule[] {
  const blocks = pageBlocks(markdown);
  const schedules: PageSchedule[] = [];
  for (const { line, offset, prose } of markdownLines(markdown)) {
    if (!prose) continue;
    const task = TASK.exec(line);
    if (!task) continue;
    const text = task[3]!.replace(/\uFE0F/gu, "");
    const outsideCode = text.replace(/`[^`]*`/gu, (code) => " ".repeat(code.length));
    if (!outsideCode.includes(SCHEDULE_RECURRENCE) && !outsideCode.includes(SCHEDULE_AT)) continue;
    const blockId = [...blocks].reverse().find((block) => block.start <= offset)?.id ?? "";
    const mark = task[2]!;
    const status: PageScheduleStatus = mark === "-" ? "paused" : mark === " " ? "running" : "done";
    schedules.push({ ...parseScheduleText(text, outsideCode), source: line.trim(), blockId, status,
      start: offset, end: offset + line.length });
  }
  return schedules;
}

function parseScheduleText(text: string, outsideCode: string): Omit<PageSchedule,
  "source" | "blockId" | "status" | "start" | "end"> {
  const first = outsideCode.search(SIGNIFIER);
  const instruction = text.slice(0, first).trim();
  const fields = new Map<string, string>();
  let error: string | undefined;
  const rest = text.slice(first);
  for (const match of rest.matchAll(/([🔁⏳✅])([^🔁⏳✅]*)/gu)) {
    const signifier = match[1]!;
    if (fields.has(signifier)) error ??= `${signifier} is written twice`;
    fields.set(signifier, match[2]!.trim());
  }
  const result: Omit<PageSchedule, "source" | "blockId" | "status" | "start" | "end"> = { instruction, triggers: [] };
  if (!instruction) error ??= "Write what to do before 🔁 or ⏳";
  const recurrence = fields.get(SCHEDULE_RECURRENCE);
  if (recurrence !== undefined) {
    const parsed = parseRecurrence(recurrence);
    if ("error" in parsed) error ??= parsed.error;
    else Object.assign(result, parsed);
  }
  const at = fields.get(SCHEDULE_AT);
  if (at !== undefined) {
    const parsed = parseScheduleTime(at);
    if (parsed === undefined) {
      error ??= `⏳ takes a time with its offset, such as 2026-11-03 09:00 +08:00, not “${at}”`;
    } else result.at = parsed;
  }
  const done = fields.get(SCHEDULE_DONE);
  if (done !== undefined) result.doneOn = done;
  return error ? { ...result, error } : result;
}

/** 🔁's rule: `every <n> <unit>` (or `every <unit>`, `every 12h`), then `, on <trigger>` for each event. */
export function parseRecurrence(rule: string): { intervalMinutes: number; triggers: AutomationTrigger[] }
  | { error: string } {
  // Events follow the cadence after commas; a merge trigger's own paths are commas without `on`.
  const [written = "", ...events] = rule.split(/,\s*(?=on\s)/u).map((part) => part.trim());
  // Anything else after a comma is an event written some other way.
  const [cadence = "", stray] = splitOnce(written, ",").map((part) => part.trim());
  if (stray) events.unshift(stray);
  const every = /^every\s+(?:(\d+)\s*)?([a-z]+)$/iu.exec(cadence);
  const unit = every ? UNITS[every[2]!.toLowerCase()] : undefined;
  if (!every || !unit) {
    return { error: `🔁 starts with every and a cadence, such as every 12 hours or every day, not “${cadence}”` };
  }
  const intervalMinutes = Number(every[1] ?? 1) * unit;
  if (intervalMinutes < AUTOMATION_MIN_INTERVAL_MINUTES || intervalMinutes > AUTOMATION_MAX_INTERVAL_MINUTES) {
    return { error: `🔁 runs at most every ${AUTOMATION_MIN_INTERVAL_MINUTES} minutes and at least every ${
      AUTOMATION_MAX_INTERVAL_MINUTES / 1440} days` };
  }
  const triggers: unknown[] = [];
  for (const event of events) {
    const on = /^on\s+(\S+)$/u.exec(event);
    const trigger = on ? scheduleTriggerFrom(on[1]!) : undefined;
    if (!trigger) {
      return { error: `After the cadence, each event is on merged:owner/repo[@branch][:paths], `
        + `on ci-failed:owner/repo[@branch][:workflow] or on <app>:<event|*>[:<source>], not “${event}”` };
    }
    triggers.push(trigger);
  }
  try {
    return { intervalMinutes, triggers: automationTriggersFrom(triggers) };
  } catch (failure) {
    return { error: `🔁 ${(failure as Error).message}` };
  }
}

/** One event as written after `on`, as the stored trigger; the same spelling as `--on`. */
export function scheduleTriggerFrom(value: string): Record<string, unknown> | undefined {
  const [kind = "", rest = ""] = splitOnce(value, ":");
  if (!rest) return undefined;
  if (kind === "merged" || kind === "ci-failed") {
    const [target, extra] = splitOnce(rest, ":");
    const [repository, branch] = splitOnce(target!, "@");
    if (repository!.split("/").filter(Boolean).length !== 2) return undefined;
    return {
      kind, repository, ...(branch ? { branch } : {}),
      ...(extra ? kind === "merged"
        ? { paths: extra.split(",").map((path) => path.trim()).filter(Boolean) } : { workflow: extra } : {}),
    };
  }
  if (!/^[a-z][a-z0-9-]*$/u.test(kind)) return undefined;
  const [feature, source] = splitOnce(rest, ":");
  if (!feature) return undefined;
  return { kind: "event", provider: kind, source: source || "*", ...(feature !== "*" ? { feature } : {}) };
}

/** How a trigger is written after `on`. */
export function scheduleTriggerText(trigger: AutomationTrigger): string {
  if (trigger.kind === "event") {
    return `${trigger.provider}:${trigger.feature ?? "*"}${trigger.source === "*" ? "" : `:${trigger.source}`}`;
  }
  const target = `${trigger.repository}${trigger.branch ? `@${trigger.branch}` : ""}`;
  if (trigger.kind === "merged") return `merged:${target}${trigger.paths?.length ? `:${trigger.paths.join(",")}` : ""}`;
  return `ci-failed:${target}${trigger.workflow ? `:${trigger.workflow}` : ""}`;
}

function splitOnce(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + separator.length)];
}

/** ⏳'s time: a date and time with its offset (`2026-11-03 09:00 +08:00`, ISO, or Z), as UTC. */
export function parseScheduleTime(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(Z|[+-]\d{2}:?\d{2})$/iu.exec(value.trim());
  if (!match) return undefined;
  const offset = match[3]!.toUpperCase() === "Z" ? "Z"
    : match[3]!.includes(":") ? match[3]! : `${match[3]!.slice(0, 3)}:${match[3]!.slice(3)}`;
  const time = match[2]!.length === 5 ? `${match[2]}:00` : match[2]!;
  const ms = Date.parse(`${match[1]}T${time}${offset}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** How a cadence is written after `every`. */
export function scheduleCadenceText(minutes: number): string {
  for (const [unit, size] of [["week", 10080], ["day", 1440], ["hour", 60]] as const) {
    if (minutes % size === 0) return minutes === size ? `every ${unit}` : `every ${minutes / size} ${unit}s`;
  }
  return `every ${minutes} minutes`;
}

/** A schedule's line, as the page writes it. */
export function scheduleLine(input: { instruction: string; status?: PageScheduleStatus; intervalMinutes?: number;
  at?: string; atText?: string; triggers?: AutomationTrigger[]; doneOn?: string }): string {
  const mark = input.status === "paused" ? "-" : input.status === "done" ? "x" : " ";
  const fields: string[] = [];
  if (input.intervalMinutes !== undefined) {
    fields.push(`${SCHEDULE_RECURRENCE} ${[scheduleCadenceText(input.intervalMinutes),
      ...(input.triggers ?? []).map((trigger) => `on ${scheduleTriggerText(trigger)}`)].join(", ")}`);
  }
  if (input.atText ?? input.at) fields.push(`${SCHEDULE_AT} ${input.atText ?? scheduleTimeText(input.at!)}`);
  if (input.doneOn) fields.push(`${SCHEDULE_DONE} ${input.doneOn}`);
  const instruction = input.instruction.replace(/\s+/gu, " ").replace(/[🔁⏳✅]/gu, "").trim();
  return `- [${mark}] ${instruction} ${fields.join(" ")}`;
}

/** A UTC time as ⏳ writes it. */
export function scheduleTimeText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} Z`;
}

/** Whether a one-time time is ahead and within the year a reminder may be set. */
export function scheduleTimeInRange(iso: string, now = Date.now()): boolean {
  const ahead = Date.parse(iso) - now;
  return ahead > 0 && ahead <= AUTOMATION_MAX_ONCE_LEAD_MINUTES * 60_000;
}

/**
 * The page with one schedule's line marked: `[x] … ✅ <day>` once a one-time
 * schedule has run, as Obsidian marks a done task. The line is found by its
 * source; a page that no longer holds it is returned unchanged.
 */
export function markScheduleDone(markdown: string, source: string, day: string): string {
  const schedule = pageSchedules(markdown).find((candidate) => candidate.source === source);
  if (!schedule || schedule.status === "done") return markdown;
  const line = markdown.slice(schedule.start, schedule.end);
  const marked = line.replace(/\[[ -]\]/u, "[x]").replace(/\s*✅[^🔁⏳✅]*$/u, "");
  return `${markdown.slice(0, schedule.start)}${marked} ${SCHEDULE_DONE} ${day}${markdown.slice(schedule.end)}`;
}

/** The page with one schedule's line set running (`[ ]`) or paused (`[-]`); unchanged when it is not there. */
export function setScheduleStatus(markdown: string, source: string, status: "running" | "paused"): string {
  const schedule = pageSchedules(markdown).find((candidate) => candidate.source === source);
  if (!schedule) return markdown;
  const line = markdown.slice(schedule.start, schedule.end);
  const marked = line.replace(/\[[ xX-]\]/u, status === "paused" ? "[-]" : "[ ]").replace(/\s*✅[^🔁⏳✅]*$/u, "");
  return `${markdown.slice(0, schedule.start)}${marked}${markdown.slice(schedule.end)}`;
}

/** The page without one schedule's line; unchanged when it is not there. */
export function removeScheduleLine(markdown: string, source: string): string {
  const schedule = pageSchedules(markdown).find((candidate) => candidate.source === source);
  if (!schedule) return markdown;
  const end = markdown[schedule.end] === "\n" ? schedule.end + 1 : schedule.end;
  return `${markdown.slice(0, schedule.start)}${markdown.slice(end)}`;
}
