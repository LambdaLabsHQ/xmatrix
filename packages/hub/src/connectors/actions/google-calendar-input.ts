import { record } from "../command-support";

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
export const EVENT_ID = /^[a-zA-Z0-9_-]{5,1024}$/u;
const ETAG = /^"[\x21\x23-\x7e]{1,200}"$/u;

export function calendarId(value: unknown): value is string {
  return typeof value === "string" && /^(?:primary|[A-Za-z0-9._%+@-]{1,254})$/u.test(value) && value !== "." && value !== "..";
}

export function calendarJson(text: string, allowed: readonly string[]): Record<string, unknown> | undefined {
  if (text.length > 4_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const input = record(parsed);
    return Object.keys(input).every(key => allowed.includes(key)) ? input : undefined;
  } catch { return undefined; }
}

function stamp(value: unknown): value is string {
  if (typeof value !== "string" || !STAMP.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day &&
    Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60;
}

export function calendarWindow(input: Record<string, unknown>): boolean {
  return stamp(input.timeMin) && stamp(input.timeMax) && Date.parse(input.timeMax) > Date.parse(input.timeMin) &&
    Date.parse(input.timeMax) - Date.parse(input.timeMin) <= 366 * 86_400_000;
}

export function pageToken(value: unknown): boolean {
  return value === undefined || typeof value === "string" && /^[A-Za-z0-9_=+/.:-]{1,2048}$/u.test(value);
}

function eventTime(value: unknown): { date?: string; dateTime?: string; timeZone?: string } | undefined {
  const input = record(value);
  if (Object.keys(input).some(key => !["date", "dateTime", "timeZone"].includes(key))) return undefined;
  if (input.timeZone !== undefined) {
    if (typeof input.timeZone !== "string" || input.timeZone.length > 100) return undefined;
    try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }); } catch { return undefined; }
  }
  if (typeof input.date === "string" && DAY.test(input.date) && !input.dateTime && !input.timeZone &&
    Number.isFinite(Date.parse(input.date)) && new Date(input.date).toISOString().slice(0, 10) === input.date) return { date: input.date };
  if (stamp(input.dateTime) && !input.date) return { dateTime: input.dateTime, ...(input.timeZone ? { timeZone: input.timeZone as string } : {}) };
  return undefined;
}

const CONTENT_FIELDS = ["summary", "description", "location", "start", "end", "attendees", "recurrence", "visibility", "transparency"];
export const MUTATION_FIELDS = ["id", "eventId", "etag", "sendUpdates", ...CONTENT_FIELDS];

/** Only ordinary event content, never calendar ACLs, organizer impersonation or arbitrary API fields. */
export function eventMutation(input: Record<string, unknown>, mode: "create" | "update" | "delete"): Record<string, unknown> | undefined {
  if (typeof input.sendUpdates !== "string" || !["all", "externalOnly", "none"].includes(input.sendUpdates)) return undefined;
  if (mode === "create") {
    if (typeof input.id !== "string" || !/^[a-v0-9]{5,1024}$/u.test(input.id) || input.eventId !== undefined || input.etag !== undefined ||
      typeof input.summary !== "string" || !input.summary.trim() || !input.start || !input.end) return undefined;
  } else if (typeof input.eventId !== "string" || !EVENT_ID.test(input.eventId) || typeof input.etag !== "string" || !ETAG.test(input.etag) || input.id !== undefined) return undefined;
  const body = Object.fromEntries(CONTENT_FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  if (mode === "delete") return Object.keys(body).length ? undefined : {};
  if (!Object.keys(body).length) return undefined;
  for (const [field, max] of [["summary", 250], ["description", 3000], ["location", 500]] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== "string" || value.length > max || Array.from(value).some(character => {
      const point = character.charCodeAt(0);
      return point === 127 || point < 32 && ![9, 10, 13].includes(point);
    }))) return undefined;
  }
  // Moving an event requires the complete interval; a partial PATCH must not invent the other endpoint.
  if (body.start !== undefined || body.end !== undefined) {
    const start = eventTime(body.start), end = eventTime(body.end);
    if (!start || !end || Boolean(start.date) !== Boolean(end.date) ||
      Date.parse(end.date ?? end.dateTime!) <= Date.parse(start.date ?? start.dateTime!)) return undefined;
    body.start = start; body.end = end;
  }
  if (body.attendees !== undefined && (!Array.isArray(body.attendees) || body.attendees.length > 50 ||
    body.attendees.some(value => {
      const attendee = record(value);
      return Object.keys(attendee).some(key => key !== "email" && key !== "optional") ||
        typeof attendee.email !== "string" || !/^[^\s@<>]{1,128}@[^\s@<>]{1,125}$/u.test(attendee.email) ||
        attendee.optional !== undefined && typeof attendee.optional !== "boolean";
    }))) return undefined;
  if (body.recurrence !== undefined && (!Array.isArray(body.recurrence) || body.recurrence.length > 5 ||
    body.recurrence.some(value => typeof value !== "string" || value.length > 500 || !/^(?:RRULE|RDATE|EXDATE)(?:;[^:\r\n]+)?:[^\r\n]+$/u.test(value)) ||
    body.recurrence.length && (mode === "create" || body.start !== undefined) && !record(body.start).date && (!record(body.start).timeZone || !record(body.end).timeZone))) return undefined;
  if (body.visibility !== undefined && (typeof body.visibility !== "string" || !["default", "public", "private", "confidential"].includes(body.visibility))) return undefined;
  if (body.transparency !== undefined && (typeof body.transparency !== "string" || !["opaque", "transparent"].includes(body.transparency))) return undefined;
  return mode === "create" ? { id: input.id, ...body } : body;
}
