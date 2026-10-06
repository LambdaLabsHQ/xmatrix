/**
 * The one place an instant becomes something a person reads.
 *
 * Every instant xMatrix stores or sends is UTC RFC-3339 with a trailing `Z`.
 * Rendering strips that: once "4:23 AM" has been screenshotted, quoted into a
 * channel, or pasted to an agent, nothing in the string says which zone it was
 * rendered in, and a reader who assumes the wrong one is off by exactly that
 * zone's offset. A Focus review read a UTC transcript against a UTC+8 wall
 * clock and reported four minutes of silence as eight hours.
 *
 * So the choice of rendering is a correctness decision, not a style one:
 *
 * - {@link formatRelativeAge} answers "how long ago". A duration has no zone
 *   and cannot be misread, so prefer it wherever the question is recency.
 * - {@link formatLocalClock} is a bare local time for a row that sits among
 *   other rows in the same zone, where a zone on every line is noise. Message
 *   rows read this way in Slack and here.
 * - {@link formatZonedDateTime} is a complete instant that names its zone.
 *   Required for anything a reader can lift out of its surroundings: hover
 *   titles, evidence lines, tables, profile cards, exports.
 *
 * When in doubt between the last two, ask whether the string still means one
 * thing after being copied somewhere else. If not, it needs the zone.
 */

const SECOND_MS = 1000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * How long ago `value` was, as a duration rather than an instant.
 *
 * Returns `null` rather than a guess when the timestamp cannot be parsed, so a
 * caller decides what an unknown age looks like instead of inheriting a wrong
 * one. Ages are floored, never rounded up: "3m ago" is at least three minutes.
 */
export function formatRelativeAge(
  value: string | undefined | null,
  nowMs: number = Date.now()
): string | null {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) return null;
  /* A clock that disagrees with the server can put an instant slightly in the
     future. Clamping to zero reads as "just now", which is true, where a
     negative age would render as nonsense. */
  const seconds = Math.max(0, Math.floor((nowMs - parsed) / SECOND_MS));
  if (seconds < MINUTE_SECONDS) return "just now";
  if (seconds < HOUR_SECONDS) return `${Math.floor(seconds / MINUTE_SECONDS)}m ago`;
  if (seconds < DAY_SECONDS) return `${Math.floor(seconds / HOUR_SECONDS)}h ago`;
  return `${Math.floor(seconds / DAY_SECONDS)}d ago`;
}

/** Whole days between `value` and `nowMs`, for callers that switch to an absolute date past some age. */
export function ageInDays(value: string | undefined | null, nowMs: number = Date.now()): number | null {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / (DAY_SECONDS * SECOND_MS)));
}

/**
 * A bare local time — "4:23 AM" — for rows read in the company of other rows.
 *
 * Deliberately zone-less: the surrounding rows are in the same zone, so naming
 * it on each line adds nothing a reader does not already know. Anything that
 * can be read alone wants {@link formatZonedDateTime} instead.
 */
export function formatLocalClock(
  value: string | Date,
  locale?: Intl.LocalesArgument,
  timeZone?: string
): string {
  return formatInstant(value, locale, { hour: "numeric", minute: "2-digit", timeZone });
}

/**
 * A complete instant that names its own zone — "Sep 19, 2026, 4:23 AM GMT+8".
 *
 * `timeZoneName` is the whole point: this is the rendering used wherever a
 * string outlives its context, and a zone-less absolute time in a quotable
 * position is the defect this module exists to prevent.
 */
export function formatZonedDateTime(
  value: string | Date,
  locale?: Intl.LocalesArgument,
  timeZone?: string,
  options?: Pick<Intl.DateTimeFormatOptions, "year" | "month" | "day" | "second" | "hour12">
): string {
  return formatInstant(value, locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
    ...options,
  });
}

/** The IANA zone this browser is rendering in, for the rare caller that must state it separately. */
export function resolvedTimeZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shared parse-and-format. An unparseable timestamp renders as itself rather
 * than as "Invalid Date": the raw value is at least evidence of what arrived.
 */
export function formatInstant(
  value: string | Date,
  locale: Intl.LocalesArgument | undefined,
  options: Intl.DateTimeFormatOptions
): string {
  /* A `Date` is accepted because some callers have already parsed a value this
     module could not — an epoch number, a legacy format — and re-parsing the
     original string there would quietly render the fallback instead. */
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return typeof value === "string" ? value : "";
  return dateTimeFormat(locale, options).format(date);
}

const DATE_TIME_FORMAT_CACHE_LIMIT = 64;
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * One `Intl.DateTimeFormat` per locale and options. Building one resolves
 * locale data and costs about as much as rendering the row that shows it, and
 * every message timestamp and conversation row formats on each render, so
 * under a busy Space the constructors alone took a third of the main thread.
 */
export function dateTimeFormat(
  locale: Intl.LocalesArgument | undefined,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = JSON.stringify([locale ?? null, options]);
  let format = dateTimeFormats.get(key);
  if (!format) {
    if (dateTimeFormats.size >= DATE_TIME_FORMAT_CACHE_LIMIT) {
      dateTimeFormats.delete(dateTimeFormats.keys().next().value!);
    }
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

/**
 * A conversation list's time column: a clock time today, then "Yesterday",
 * a weekday within the week, and a short date after that.
 */
export function mobileChatTimeLabel(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startOfToday) {
    return dateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  if (ms >= startOfToday - 86400000) return "Yesterday";
  if (ms >= startOfToday - 6 * 86400000) return dateTimeFormat(undefined, { weekday: "short" }).format(date);
  return dateTimeFormat(undefined, { month: "numeric", day: "numeric" }).format(date);
}

/** Milliseconds used for trace ordering; absent or invalid timestamps sort at zero. */
export function timestampMillisOrZero(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}
