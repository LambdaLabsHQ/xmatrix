import { Bell, CalendarDays, Eye, MapPin, Repeat, Users } from "lucide-react";

/**
 * The event a Google Calendar write would leave behind, read as an event and
 * not as fields: the date on the left as a desk calendar shows it, then the
 * title, when, where and who. The Hub freezes these keys before it asks; the
 * dates are formatted here, in the reader's language, in the event's own zone.
 */
export interface CalendarEventDraft {
  change: "create" | "update" | "delete";
  /** The event's current title, when the write changes or deletes one. */
  event?: string;
  calendar: string;
  title: string;
  /** ISO 8601 with offset, or `YYYY-MM-DD` for an all-day event whose `end` is exclusive. */
  start: string;
  end: string;
  timeZone: string;
  location?: string;
  /** Comma-separated emails of every guest; `optionalGuests` names those who are optional. */
  guests?: string;
  optionalGuests?: string;
  notes?: string;
  /** RRULE lines, one per line; `(no recurrence)` when a change removes the repeat. */
  recurrence?: string;
  /** Who Google emails about the change. */
  sendUpdates?: "all" | "externalOnly" | "none";
  /** For one event of a repeating series: the whole series or this occurrence. */
  series?: "all" | "this";
  /** Who sees the event's details, when not the calendar's default. */
  visibility?: string;
  /** `transparent` when the event leaves the time free. */
  transparency?: string;
  /** Why the guest list shown may be incomplete. */
  guestsIncomplete?: string;
  /** The exact PATCH body of an update, in Google's field names; `[]` or `""` clears a field. */
  changes?: Record<string, unknown>;
}

const NO_RECURRENCE = "(no recurrence)";
const SEND_UPDATES = { all: "Emails every guest", externalOnly: "Emails only guests outside your organization", none: "Emails no one" } as const;
/** Google's field names, in the words the card uses for them. */
const FIELD_NAMES: Record<string, string> = {
  summary: "title", start: "time", end: "time", location: "place", description: "notes", attendees: "guests", recurrence: "repeat",
  visibility: "visibility", transparency: "busy status",
};
const VISIBILITY: Record<string, string> = { private: "Private: only guests see the details", confidential: "Private: only guests see the details", public: "Public: anyone with the calendar sees the details" };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function calendarEventDraft(preview: Record<string, string>): CalendarEventDraft {
  const change = preview.change;
  if (change !== "create" && change !== "update" && change !== "delete") {
    throw new Error(`Google Calendar approval preview has no valid change (got ${JSON.stringify(change)})`);
  }
  for (const key of ["calendar", "title", "start", "end", "timeZone"] as const) {
    if (!preview[key]) throw new Error(`Google Calendar approval preview is missing ${key}`);
  }
  const { sendUpdates, series } = preview;
  if (sendUpdates !== undefined && !(sendUpdates in SEND_UPDATES)) throw new Error(`Google Calendar approval preview has an unknown sendUpdates ${JSON.stringify(sendUpdates)}`);
  if (series !== undefined && series !== "all" && series !== "this") throw new Error(`Google Calendar approval preview has an unknown series ${JSON.stringify(series)}`);
  let changes: Record<string, unknown> | undefined;
  if (preview.changes !== undefined) {
    try { changes = JSON.parse(preview.changes) as Record<string, unknown>; } catch { throw new Error("Google Calendar approval preview has changes that are not JSON"); }
  }
  return {
    change, calendar: preview.calendar!, title: preview.title!, start: preview.start!, end: preview.end!, timeZone: preview.timeZone!,
    ...(preview.event ? { event: preview.event } : {}),
    ...(preview.location ? { location: preview.location } : {}),
    ...(preview.guests ? { guests: preview.guests } : {}),
    ...(preview.optionalGuests ? { optionalGuests: preview.optionalGuests } : {}),
    ...(preview.notes ? { notes: preview.notes } : {}),
    ...(preview.recurrence ? { recurrence: preview.recurrence } : {}),
    ...(sendUpdates ? { sendUpdates: sendUpdates as keyof typeof SEND_UPDATES } : {}),
    ...(series ? { series } : {}),
    ...(changes ? { changes } : {}),
    ...(preview.visibility ? { visibility: preview.visibility } : {}),
    ...(preview.transparency ? { transparency: preview.transparency } : {}),
    ...(preview.guestsIncomplete ? { guestsIncomplete: preview.guestsIncomplete } : {}),
  };
}

export function calendarApprovalQuestion(draft: CalendarEventDraft): string {
  if (draft.change === "create") return "Add this event to the calendar?";
  if (draft.change === "delete") return "Delete this event?";
  return draft.event && draft.event !== draft.title ? `Change “${draft.event}” to this?` : "Change this event?";
}

function emails(list?: string): string[] {
  return list?.split(",").map(email => email.trim()).filter(Boolean) ?? [];
}

/** "Changes title and time · Clears place and guests", from the PATCH body an update sends. */
export function calendarChangeSummary(changes: Record<string, unknown>): string {
  const changed = new Set<string>();
  const cleared = new Set<string>();
  for (const [field, value] of Object.entries(changes)) {
    const name = FIELD_NAMES[field];
    if (!name) continue;
    (value === "" || (Array.isArray(value) && value.length === 0) ? cleared : changed).add(name);
  }
  const words = (names: Set<string>) => new Intl.ListFormat("en", { type: "conjunction" }).format([...names]);
  return [changed.size ? `Changes ${words(changed)}` : "", cleared.size ? `Clears ${words(cleared)}` : ""].filter(Boolean).join(" · ");
}

const FREQUENCIES: Record<string, [string, string]> = { DAILY: ["Daily", "days"], WEEKLY: ["Weekly", "weeks"], MONTHLY: ["Monthly", "months"], YEARLY: ["Yearly", "years"] };
const WEEKDAYS: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

/**
 * "Weekly on Mon, Wed · 10 times", for the rules people write; a rule with any
 * other part stays as Google stores it, so nothing it does is left unsaid.
 */
export function calendarRepeatText(rule: string): string {
  const match = /^RRULE:(.+)$/.exec(rule);
  if (!match) return rule;
  const parts = Object.fromEntries(match[1]!.split(";").map(part => part.split("=") as [string, string]));
  const known = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]);
  const frequency = FREQUENCIES[parts.FREQ ?? ""];
  const days = parts.BYDAY?.split(",").map(day => WEEKDAYS[day]);
  if (!frequency || Object.keys(parts).some(key => !known.has(key)) || days?.some(day => !day)) return rule;
  const interval = Number(parts.INTERVAL ?? "1");
  const until = parts.UNTIL ? /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL) : null;
  if (!Number.isInteger(interval) || interval < 1 || (parts.UNTIL && !until)) return rule;
  return [
    `${interval === 1 ? frequency[0] : `Every ${interval} ${frequency[1]}`}${days ? ` on ${days.join(", ")}` : ""}`,
    parts.COUNT ? `${parts.COUNT} times` : "",
    until ? `until ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${until[1]}-${until[2]}-${until[3]}T12:00:00Z`))}` : "",
  ].filter(Boolean).join(" · ");
}

/** All-day dates are calendar days; read them at UTC noon so no zone shifts the day. */
function instant(value: string): Date {
  return new Date(DATE_ONLY.test(value) ? `${value}T12:00:00Z` : value);
}

function dayBefore(value: string): string {
  const day = instant(value);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** "Thu, Oct 30 · 3:00 – 4:00 PM GMT+8", "Thu, Oct 30 – Sat, Nov 1 · All day", in the reader's locale. */
export function calendarEventWhen(draft: Pick<CalendarEventDraft, "start" | "end" | "timeZone">, locale?: string): string {
  const allDay = DATE_ONLY.test(draft.start);
  const timeZone = allDay ? "UTC" : draft.timeZone;
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone });
  const start = instant(draft.start);
  if (allDay) {
    const last = instant(dayBefore(draft.end));
    const days = last.getTime() > start.getTime() ? day.formatRange(start, last) : day.format(start);
    return `${days} · All day`;
  }
  const end = instant(draft.end);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" });
  const sameDay = day.format(start) === day.format(end);
  if (sameDay) return `${day.format(start)} · ${time.formatRange(start, end)}`;
  const moment = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" });
  return moment.formatRange(start, end);
}

export function CalendarEventPreview({ draft, locale }: { draft: CalendarEventDraft; locale?: string }) {
  const timeZone = DATE_ONLY.test(draft.start) ? "UTC" : draft.timeZone;
  const start = instant(draft.start);
  const month = new Intl.DateTimeFormat(locale, { month: "short", timeZone }).format(start);
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", timeZone }).format(start);
  const optional = new Set(emails(draft.optionalGuests));
  const guests = emails(draft.guests).map(guest => optional.has(guest) ? `${guest} (optional)` : guest);
  const removed = draft.change === "delete";
  const repeats = draft.recurrence && draft.recurrence !== NO_RECURRENCE ? draft.recurrence.split("\n").map(line => line.trim()).filter(Boolean) : [];
  const scope = draft.series === "all" ? (removed ? "Every event in the series" : "Applies to every event in the series")
    : draft.series === "this" ? (removed ? "Only this occurrence" : "Applies to this occurrence only") : null;
  const visibility = draft.visibility && draft.visibility !== "default" ? VISIBILITY[draft.visibility] ?? draft.visibility : null;
  const changeSummary = draft.change === "update" && draft.changes ? calendarChangeSummary(draft.changes) : "";
  return (
    <div className="mt-3 flex min-w-0 gap-3" data-calendar-event={draft.change}>
      <div className="flex w-11 shrink-0 flex-col items-center leading-none" aria-hidden="true">
        <span className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{month}</span>
        <span className="mt-1 text-[26px] font-extrabold tabular-nums tracking-tight">{date}</span>
      </div>
      <div className={`min-w-0 flex-1 text-sm ${removed ? "text-muted-foreground" : ""}`}>
        <p className="text-[15px] font-bold leading-snug [overflow-wrap:anywhere]">{draft.title}</p>
        <p className="mt-0.5">{calendarEventWhen(draft, locale)}{draft.transparency === "transparent" ? " · Shows as free" : ""}</p>
        {changeSummary || scope ? <p className="mt-1 font-semibold">{[changeSummary, scope].filter(Boolean).join(" · ")}</p> : null}
        {repeats.length ? <p className="mt-1.5 flex min-w-0 items-start gap-1.5 text-muted-foreground">
          <Repeat className="mt-0.5 size-3.5 shrink-0" aria-label="Repeats" />
          <span className="[overflow-wrap:anywhere]">{repeats.map(calendarRepeatText).join("; ")}</span>
        </p> : null}
        {draft.location ? <p className="mt-1.5 flex min-w-0 items-start gap-1.5 text-muted-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" aria-label="Where" />
          <span className="[overflow-wrap:anywhere]">{draft.location}</span>
        </p> : null}
        {guests.length ? <p className="mt-1 flex min-w-0 items-start gap-1.5 text-muted-foreground">
          <Users className="mt-0.5 size-3.5 shrink-0" aria-label="Guests" />
          <span className="[overflow-wrap:anywhere]">{guests.join(", ")}</span>
        </p> : null}
        <p className="mt-1 flex min-w-0 items-start gap-1.5 text-muted-foreground">
          <CalendarDays className="mt-0.5 size-3.5 shrink-0" aria-label="Calendar" />
          <span className="[overflow-wrap:anywhere]">{draft.calendar}</span>
        </p>
        {draft.guestsIncomplete ? <p className="mt-1 text-destructive">{draft.guestsIncomplete}</p> : null}
        {visibility ? <p className="mt-1 flex min-w-0 items-start gap-1.5 text-muted-foreground">
          <Eye className="mt-0.5 size-3.5 shrink-0" aria-label="Visibility" />
          <span>{visibility}</span>
        </p> : null}
        {draft.sendUpdates ? <p className="mt-1 flex min-w-0 items-start gap-1.5 text-muted-foreground">
          <Bell className="mt-0.5 size-3.5 shrink-0" aria-label="Notifications" />
          <span>{SEND_UPDATES[draft.sendUpdates]}</span>
        </p> : null}
        {draft.notes ? <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.notes}</p> : null}
      </div>
    </div>
  );
}
