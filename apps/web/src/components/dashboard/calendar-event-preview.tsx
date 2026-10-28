import { CalendarDays, MapPin, Users } from "lucide-react";

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
  /** Comma-separated guest emails. */
  guests?: string;
  notes?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function calendarEventDraft(preview: Record<string, string>): CalendarEventDraft {
  const change = preview.change;
  if (change !== "create" && change !== "update" && change !== "delete") {
    throw new Error(`Google Calendar approval preview has no valid change (got ${JSON.stringify(change)})`);
  }
  for (const key of ["calendar", "title", "start", "end", "timeZone"] as const) {
    if (!preview[key]) throw new Error(`Google Calendar approval preview is missing ${key}`);
  }
  return {
    change, calendar: preview.calendar!, title: preview.title!, start: preview.start!, end: preview.end!, timeZone: preview.timeZone!,
    ...(preview.event ? { event: preview.event } : {}),
    ...(preview.location ? { location: preview.location } : {}),
    ...(preview.guests ? { guests: preview.guests } : {}),
    ...(preview.notes ? { notes: preview.notes } : {}),
  };
}

export function calendarApprovalQuestion(draft: CalendarEventDraft): string {
  if (draft.change === "create") return "Add this event to the calendar?";
  if (draft.change === "delete") return "Delete this event?";
  return draft.event && draft.event !== draft.title ? `Change “${draft.event}” to this?` : "Change this event?";
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
  const guests = draft.guests?.split(",").map(guest => guest.trim()).filter(Boolean) ?? [];
  const removed = draft.change === "delete";
  return (
    <div className="mt-3 flex min-w-0 gap-3" data-calendar-event={draft.change}>
      <div className="flex w-11 shrink-0 flex-col items-center leading-none" aria-hidden="true">
        <span className="text-[11px] font-extrabold uppercase tracking-wide text-muted-foreground">{month}</span>
        <span className="mt-1 text-[26px] font-extrabold tabular-nums tracking-tight">{date}</span>
      </div>
      <div className={`min-w-0 flex-1 text-sm ${removed ? "text-muted-foreground" : ""}`}>
        <p className="text-[15px] font-bold leading-snug [overflow-wrap:anywhere]">{draft.title}</p>
        <p className="mt-0.5">{calendarEventWhen(draft, locale)}</p>
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
        {draft.notes ? <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.notes}</p> : null}
      </div>
    </div>
  );
}
