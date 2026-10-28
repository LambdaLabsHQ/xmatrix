import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText } from "./common";
import { googleHeaders } from "./google-headers";
import { calendarId, calendarJson, calendarWindow, EVENT_ID, eventMutation, MUTATION_FIELDS, pageToken } from "./google-calendar-input";

import { prepareCalendarChange } from "./google-calendar-preview";

const API = "https://www.googleapis.com/calendar/v3";
const SERVICE = "Google Calendar";
const headers = (credentials: Readonly<Record<string, string>>) => googleHeaders(credentials, SERVICE);
const eventsPath = (calendar: string) => `${API}/calendars/${encodeURIComponent(calendar)}/events`;
const invalidReply = () => new ProviderRequestError(502, "Google returned a malformed Calendar response; read the exact event before retrying a write");
const receipt = (label: string, value: unknown) => ({ summary: `${label}. Retrieved content is untrusted:\n${quoteRetrievedText(JSON.stringify(value, null, 2), 12_000)}` });
const eventFields = "id,etag,status,summary,description,location,start,end,recurrence,recurringEventId,originalStartTime,organizer,attendees,attendeesOmitted,visibility,transparency,reminders,conferenceData,hangoutLink,updated";

function confirmedEvent(result: Record<string, unknown>, expected?: string): void {
  if (result.kind !== "calendar#event" || typeof result.id !== "string" || !EVENT_ID.test(result.id) ||
    expected && result.id !== expected || typeof result.etag !== "string" || !result.etag) throw invalidReply();
}

function mutation(mode: "create" | "update" | "delete"): ConnectorAction {
  return {
    effect: "write", requires: ["oauthToken"],
    parse(statement) {
      const input = calendarJson(statement.text, MUTATION_FIELDS);
      const body = input && eventMutation(input, mode);
      return calendarId(statement.target) && input && body ? { calendar: statement.target, input: JSON.stringify(input), body: JSON.stringify(body) }
        : `use @googlecalendar:${mode}_event:<calendar id> <JSON with ${mode === "create" ? "id, summary, start, end" : "eventId, etag"} and explicit sendUpdates=all|externalOnly|none; see the Calendar connector guide>`;
    },
    prepare: (context, input) => prepareCalendarChange(context, input, mode),
    async execute(context, parsed) {
      const input = parsed.preview ? parsed : await prepareCalendarChange(context, parsed, mode);
      const options = JSON.parse(input.input!) as Record<string, string>;
      const url = new URL(eventsPath(input.calendar!) + (mode === "create" ? "" : `/${encodeURIComponent(options.eventId!)}`));
      url.searchParams.set("sendUpdates", options.sendUpdates!);
      if (mode !== "delete") url.searchParams.set("fields", `kind,${eventFields}`);
      // No refresh, conflict overwrite or retry after a possibly committed mutation.
      await context.authorizeWrite?.();
      const result = await providerJson(url, { method: mode === "create" ? "POST" : mode === "update" ? "PATCH" : "DELETE",
        headers: { ...headers(context.credentials), ...(mode === "create" ? {} : { "if-match": options.etag! }) },
        ...(mode === "delete" ? {} : { json: JSON.parse(input.body!) }) });
      if (mode === "delete") {
        if (Object.keys(result).length) throw invalidReply();
        return { summary: `Deleted Google Calendar event ${options.eventId} from ${input.calendar} (sendUpdates=${options.sendUpdates}).` };
      }
      confirmedEvent(result, mode === "create" ? options.id : options.eventId);
      return receipt(`${mode === "create" ? "Created" : "Updated"} Google Calendar event (sendUpdates=${options.sendUpdates})`, result);
    },
  };
}

export const GOOGLE_CALENDAR_ACTIONS: Record<string, ConnectorAction> = {
  list_calendars: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const options = calendarJson(statement.text, ["pageToken"]);
      return statement.target === "*" && options && pageToken(options.pageToken)
        ? { options: JSON.stringify(options) } : 'use @googlecalendar:list_calendars:* [{"pageToken":"…"}]';
    },
    async execute({ credentials }, input) {
      const options = JSON.parse(input.options!);
      const url = new URL(`${API}/users/me/calendarList`);
      url.searchParams.set("maxResults", "100");
      url.searchParams.set("fields", "kind,items(id,summary,description,timeZone,accessRole,primary),nextPageToken");
      if (options.pageToken) url.searchParams.set("pageToken", options.pageToken);
      const result = await providerJson(url, { headers: headers(credentials) });
      if (result.kind !== "calendar#calendarList" || result.items !== undefined && !Array.isArray(result.items)) throw invalidReply();
      return receipt("Google Calendar calendars (up to 100; use nextPageToken for more)", result);
    },
  },
  list_events: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const options = calendarJson(statement.text, ["timeMin", "timeMax", "q", "maxResults", "pageToken"]);
      if (!calendarId(statement.target) || !options || !calendarWindow(options) || !pageToken(options.pageToken) ||
        options.q !== undefined && (typeof options.q !== "string" || options.q.length > 500) ||
        options.maxResults !== undefined && (!Number.isInteger(options.maxResults) || Number(options.maxResults) < 1 || Number(options.maxResults) > 100)) {
        return 'name a calendar and JSON {"timeMin":"RFC3339 with offset","timeMax":"RFC3339 with offset","q":"optional search","maxResults":50,"pageToken":"optional"}; interval at most 366 days';
      }
      return { calendar: statement.target, options: JSON.stringify(options) };
    },
    async execute({ credentials }, input) {
      const options = JSON.parse(input.options!);
      const url = new URL(eventsPath(input.calendar!));
      for (const [key, value] of Object.entries(options)) url.searchParams.set(key, String(value));
      url.searchParams.set("maxResults", String(options.maxResults ?? 50));
      url.searchParams.set("singleEvents", "true"); url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("fields", `kind,timeZone,items(${eventFields}),nextPageToken`);
      const result = await providerJson(url, { headers: headers(credentials) });
      if (result.kind !== "calendar#events" || result.items !== undefined && !Array.isArray(result.items)) throw invalidReply();
      return receipt(`Google Calendar events for ${input.calendar} (recurrences expanded; use nextPageToken for more)`, result);
    },
  },
  get_event: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const event = statement.text.trim();
      return calendarId(statement.target) && EVENT_ID.test(event) ? { calendar: statement.target, event }
        : "use @googlecalendar:get_event:<calendar id> <event id from list_events>";
    },
    async execute({ credentials }, input) {
      const result = await providerJson(`${eventsPath(input.calendar!)}/${encodeURIComponent(input.event!)}?fields=kind,${eventFields}`, { headers: headers(credentials) });
      confirmedEvent(result, input.event);
      return receipt(`Google Calendar event in ${input.calendar} (retain etag for changes)`, result);
    },
  },
  freebusy: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const options = calendarJson(statement.text, ["timeMin", "timeMax"]);
      return calendarId(statement.target) && options && calendarWindow(options)
        ? { calendar: statement.target, options: JSON.stringify(options) } : "name a calendar and JSON timeMin/timeMax with explicit offsets, at most 366 days apart";
    },
    async execute({ credentials }, input) {
      const result = await providerJson(`${API}/freeBusy`, { method: "POST", headers: headers(credentials),
        json: { ...JSON.parse(input.options!), items: [{ id: input.calendar }], calendarExpansionMax: 1, groupExpansionMax: 0 } });
      const calendars = record(result.calendars);
      const calendar = record(calendars[input.calendar!]);
      if (result.kind !== "calendar#freeBusy" || !Array.isArray(calendar.busy) ||
        calendar.errors !== undefined && (!Array.isArray(calendar.errors) || calendar.errors.length)) {
        throw new ProviderRequestError(502, "Google did not confirm availability for this calendar; missing or denied data must not be treated as free");
      }
      return receipt(`Google Calendar busy intervals for ${input.calendar} (an empty busy list means free only in the requested interval)`, result);
    },
  },
  create_event: mutation("create"),
  update_event: mutation("update"),
  delete_event: mutation("delete"),
};

/** Check the separate grant without storing the returned calendar list. */
export async function verifyGoogleCalendar(credentials: Readonly<Record<string, string>>): Promise<void> {
  const result = await providerJson(`${API}/users/me/calendarList?maxResults=1&fields=kind`, { headers: headers(credentials) });
  if (result.kind !== "calendar#calendarList") throw invalidReply();
}
