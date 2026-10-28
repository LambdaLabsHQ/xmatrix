import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorActionContext } from "../provider";
import { googleHeaders } from "./google-headers";
import { calendarId } from "./google-calendar-input";

/** Resolve primary and the current event before approval, freezing the exact destination and version. */
export async function prepareCalendarChange(context: ConnectorActionContext, input: Record<string, string>, mode: "create" | "update" | "delete"): Promise<Record<string, string>> {
  const headers = googleHeaders(context.credentials, "Google Calendar");
  const options = JSON.parse(input.input!);
  const calendar = await providerJson(`https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(input.calendar!)}?fields=id,summary,timeZone,primary`, { headers });
  if (!calendarId(calendar.id) || typeof calendar.summary !== "string" || typeof calendar.timeZone !== "string") {
    throw new ProviderRequestError(502, "Google did not confirm the destination calendar");
  }
  let previous: Record<string, unknown> = {};
  if (mode !== "create") {
    previous = await providerJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(options.eventId)}?maxAttendees=51`, { headers });
    if (previous.kind !== "calendar#event" || previous.id !== options.eventId || previous.etag !== options.etag || previous.status === "cancelled") {
      throw new ProviderRequestError(412, "The Calendar event changed or was removed; read it again before requesting approval");
    }
  }
  const event: Record<string, unknown> = { ...previous, ...JSON.parse(input.body!) };
  const start = record(event.start), end = record(event.end);
  const preview: Record<string, string> = {
    change: mode, calendar: calendar.primary ? calendar.id : `${calendar.summary} (${calendar.id})`,
    calendarId: calendar.id, title: typeof event.summary === "string" ? event.summary : "(untitled event)",
    start: String(start.date ?? start.dateTime ?? ""), end: String(end.date ?? end.dateTime ?? ""),
    timeZone: String(start.timeZone ?? calendar.timeZone), sendUpdates: options.sendUpdates,
    ...(mode !== "create" ? { event: String(previous.summary ?? "(untitled event)"), eventId: options.eventId } : {}),
  };
  for (const [field, key] of [["location", "location"], ["description", "notes"], ["visibility", "visibility"], ["transparency", "transparency"]]) {
    if (typeof event[field!] === "string") preview[key!] = event[field!] as string;
  }
  if (Array.isArray(event.attendees)) {
    preview.guests = event.attendees.map(value => String(record(value).email ?? "")).join(", ");
    preview.optionalGuests = event.attendees.filter(value => record(value).optional === true).map(value => String(record(value).email ?? "")).join(", ");
  }
  if (Array.isArray(event.recurrence)) preview.recurrence = event.recurrence.map(String).join("\n") || "(no recurrence)";
  if (previous.recurringEventId) {
    preview.series = "this"; preview.recurringEventId = String(previous.recurringEventId);
  } else if ([previous.recurrence, event.recurrence].some(value => Array.isArray(value) && value.length)) preview.series = "all";
  // Keep the exact submitted changes visible, including removals, optional guests and recurrence changes.
  preview.changes = input.body!;
  if (previous.attendeesOmitted) preview.guestsIncomplete = "Google omitted guests; read the complete event before replacing attendees";
  if (previous.attendeesOmitted && options.attendees !== undefined) {
    throw new ProviderRequestError(409, "Google omitted guests; replacing an incomplete guest list is not supported");
  }
  return { ...input, calendar: calendar.id, preview: JSON.stringify(preview) };
}
