import { pageSchema } from "@xmatrix/protocol/page-document";
import type { Node as DocNode } from "prosemirror-model";
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * Writing a page's schedule without typing its emoji, as Obsidian Tasks' auto-suggest
 * does (docs/design/pages-live-document.md §6.1): `@` offers when the line runs, and
 * clicking a line's timing offers it again; the pick is written into the line as
 * text (`🔁 every day`, `⏳ 2026-11-03 09:00 +08:00`), and the line becomes a task.
 */

export interface ScheduleSuggestion {
  key: string;
  /** What choosing it does, in words. */
  label: string;
  hint: string;
  /** The timing written into the line. */
  text: string;
}

const CADENCES: Array<{ words: string[]; minutes: number; label: string }> = [
  { words: ["hourly", "every", "repeat", "hour"], minutes: 60, label: "every hour" },
  { words: ["daily", "every", "repeat", "day"], minutes: 1440, label: "every day" },
  { words: ["weekly", "every", "repeat", "week"], minutes: 10080, label: "every week" },
  { words: ["every", "repeat", "12h"], minutes: 720, label: "every 12 hours" },
];
const UNIT_WORDS: Record<string, [number, string]> = { m: [1, "minutes"], h: [60, "hours"], d: [1440, "days"],
  w: [10080, "weeks"] };

/** A local time as ⏳ writes it, with this device's offset, so it is never read as UTC. */
export function scheduleTimeWithOffset(at: Date): string {
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const offset = -at.getTimezoneOffset();
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${
    pad(at.getMinutes())} ${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

function reminders(now: Date): Array<{ words: string[]; at: Date; label: string }> {
  const at = (days: number, hours: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hours, 0, 0, 0);
    return date;
  };
  const inAnHour = new Date(now.getTime() + 3_600_000);
  inAnHour.setSeconds(0, 0);
  return [
    { words: ["remind", "at", "tomorrow"], at: at(1, 9), label: "tomorrow at 9:00" },
    { words: ["remind", "at", "hour", "later"], at: inAnHour, label: "in an hour" },
    { words: ["remind", "at", "today", "tonight", "evening"], at: at(now.getHours() >= 18 ? 1 : 0, 18),
      label: now.getHours() >= 18 ? "tomorrow at 18:00" : "today at 18:00" },
    { words: ["remind", "at", "week", "monday"], at: at((8 - now.getDay()) % 7 || 7, 9), label: "next Monday at 9:00" },
  ];
}

/**
 * The schedules `@<query>` offers: cadences and reminders whose words start with what was typed,
 * `@12h`-style cadences, and with nothing typed the two most asked for.
 */
export function scheduleSuggestions(query: string, now = new Date()): ScheduleSuggestion[] {
  const wanted = query.toLowerCase();
  const repeat = (minutes: number, label: string): ScheduleSuggestion => ({ key: `repeat:${minutes}`,
    label: `Repeat ${label}`, hint: "Runs this line on a schedule", text: `🔁 ${label}` });
  const remind = (at: Date, label: string): ScheduleSuggestion => ({ key: `remind:${at.getTime()}`,
    label: `Remind ${label}`, hint: "Runs this line once, then checks it off", text: `⏳ ${scheduleTimeWithOffset(at)}` });
  const typed = /^(\d+)([mhdw])$/u.exec(wanted);
  if (typed) {
    const [size, unit] = UNIT_WORDS[typed[2]!]!;
    const amount = Number(typed[1]);
    const minutes = amount * size;
    if (minutes >= 15 && minutes <= 43200) return [repeat(minutes, amount === 1 ? `every ${unit.slice(0, -1)}` : `every ${amount} ${unit}`)];
    return [];
  }
  const matches = (words: string[]) => wanted.length > 0 && words.some((word) => word.startsWith(wanted));
  if (!wanted) return [repeat(1440, "every day"), remind(reminders(now)[0]!.at, reminders(now)[0]!.label)];
  return [
    ...CADENCES.filter((cadence) => matches(cadence.words)).map((cadence) => repeat(cadence.minutes, cadence.label)),
    ...reminders(now).filter((reminder) => matches(reminder.words)).map((reminder) => remind(reminder.at, reminder.label)),
  ];
}

/** The list item and paragraph the position is in, when it is one. */
function itemAt(doc: DocNode, pos: number): { item: DocNode; itemPos: number; paragraph: DocNode; start: number } | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type !== pageSchema.nodes.list_item) continue;
    const item = $pos.node(depth);
    const paragraph = item.firstChild;
    if (!paragraph?.isTextblock) return null;
    return { item, itemPos: $pos.before(depth), paragraph, start: $pos.before(depth) + 2 };
  }
  return null;
}

/** Where the line's timing starts (its first 🔁 or ⏳), as a document position; its end when it has none. */
export function scheduleTimingRange(paragraph: DocNode, start: number): { from: number; to: number } {
  const text = paragraph.textBetween(0, paragraph.content.size, undefined, "￼");
  const at = text.search(/[🔁⏳]/u);
  const end = start + paragraph.content.size;
  return { from: at < 0 ? end : start + at, to: end };
}

/**
 * Writes `timing` into the line at `pos` in place of what timing it had, after removing what
 * was typed to ask for it (`remove`), and makes the line a task. A line outside a list becomes
 * one; a paused line (`[-]`) stays paused.
 */
export function writeScheduleTiming(view: EditorView, pos: number, timing: string,
  remove?: { from: number; to: number }): void {
  let tr: Transaction = view.state.tr;
  if (remove) tr = tr.delete(remove.from, remove.to);
  let at = tr.mapping.map(pos);
  if (!itemAt(tr.doc, at)) {
    const $at = tr.doc.resolve(at);
    const range = $at.blockRange();
    if (!range) return;
    tr = tr.wrap(range, [{ type: pageSchema.nodes.bullet_list, attrs: { tight: true } },
      { type: pageSchema.nodes.list_item, attrs: { checked: false } }]);
    at = tr.mapping.map(at);
  }
  const found = itemAt(tr.doc, at)!;
  const paused = /^\[-\]\s/u.test(found.paragraph.textContent);
  if (found.item.attrs.checked === null && !paused) {
    tr = tr.setNodeMarkup(found.itemPos, undefined, { ...found.item.attrs, checked: false });
  }
  const refound = itemAt(tr.doc, tr.mapping.map(at, -1)) ?? found;
  const range = scheduleTimingRange(refound.paragraph, refound.start);
  const before = refound.paragraph.textBetween(0, range.from - refound.start, undefined, "￼");
  const lead = before.length === 0 || /\s$/u.test(before) ? "" : " ";
  tr = tr.insertText(`${lead}${timing}`, range.from, range.to);
  tr = tr.setSelection(TextSelection.create(tr.doc, range.from + lead.length + timing.length));
  view.dispatch(tr.scrollIntoView());
}

/** Pauses (`- [-]`) or resumes (`- [ ]`) the schedule line at `pos`. */
export function setSchedulePausedAt(state: EditorState, dispatch: (tr: Transaction) => void, pos: number,
  paused: boolean): void {
  const found = itemAt(state.doc, pos);
  if (!found) return;
  const isPaused = found.item.attrs.checked === null && /^\[-\]\s/u.test(found.paragraph.textContent);
  if (isPaused === paused) return;
  let tr = state.tr;
  if (paused) {
    tr = tr.setNodeMarkup(found.itemPos, undefined, { ...found.item.attrs, checked: null }).insertText("[-] ", found.start);
  } else {
    tr = tr.delete(found.start, found.start + 4).setNodeMarkup(found.itemPos, undefined, { ...found.item.attrs, checked: false });
  }
  dispatch(tr);
}

/** Whether the line at `pos` is a paused schedule. */
export function schedulePausedAt(doc: DocNode, pos: number): boolean {
  const found = itemAt(doc, pos);
  return Boolean(found && found.item.attrs.checked === null && /^\[-\]\s/u.test(found.paragraph.textContent));
}
