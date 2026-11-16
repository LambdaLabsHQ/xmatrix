import { markdownLines } from "./page-markdown.js";

/**
 * The schedule lines still written in a page. A schedule was a task line
 * written as Obsidian Tasks writes a recurring or scheduled task:
 *
 *   - [ ] Audit the code for bloat; record it here 🔁 every 12 hours
 *   - [ ] Remind @Yiming to renew the domain ⏳ 2026-11-03 09:00 +08:00
 *   - [x] Remind Daniel about the quarterly tax ⏳ 2026-10-30 09:00 +08:00 ✅ 2026-10-30
 *
 * Schedule lines no longer run; scheduled work is a program on the page. The
 * lines are found only so an edit can say so about each one not yet done.
 */

export type PageScheduleStatus = "running" | "paused" | "done";

export interface PageSchedule {
  /** The line as written, without its indent. */
  source: string;
  /** `[ ]` was running, `[-]` paused, `[x]` done. */
  status: PageScheduleStatus;
}

// Schedule text contains a non-whitespace signifier. Keep its first character
// disjoint from the separator so a malformed line cannot redistribute blanks.
const TASK = /^(\s*)[-*+]\s\[([ xX-])\]\s+(\S.*)$/u;

/** Every schedule line written in the page, outside code, in order. */
export function pageSchedules(markdown: string): PageSchedule[] {
  const schedules: PageSchedule[] = [];
  for (const { line, prose } of markdownLines(markdown)) {
    if (!prose) continue;
    const task = TASK.exec(line);
    if (!task) continue;
    const outsideCode = task[3]!.replace(/️/gu, "").replace(/`[^`]*`/gu, (code) => " ".repeat(code.length));
    if (!outsideCode.includes("🔁") && !outsideCode.includes("⏳")) continue;
    const mark = task[2]!;
    schedules.push({ source: line.trim(), status: mark === "-" ? "paused" : mark === " " ? "running" : "done" });
  }
  return schedules;
}
