import { dateTimeFormat, formatInstant, formatZonedDateTime } from "./time-display";

type SequencedHistoryEntry = {
  sequence?: number;
};

type ChannelHistoryLike = SequencedHistoryEntry & {
  messageId: string;
  channelId?: string;
  sentAt: string;
};

export function formatMessageDateTime(
  value: string,
  locale?: Intl.LocalesArgument,
  timeZone?: string
): string {
  /* The hover read, and the only message timestamp a reader can lift out of
     the timeline — into a screenshot, a channel message, an agent prompt. The
     compact label above stays zone-less because its neighbours share its zone;
     this one has no neighbours, so it names the zone itself. */
  return formatZonedDateTime(value, locale, timeZone);
}

export function formatMessageTimestamp(
  value: string,
  referenceTime: Date = new Date(),
  locale?: Intl.LocalesArgument,
  timeZone?: string
): string {
  const date = new Date(value);
  const messageDay = messageCalendarDate(date, timeZone);
  const referenceDay = messageCalendarDate(referenceTime, timeZone);
  if (!messageDay || !referenceDay) return value;

  const daysAgo = calendarDayNumber(referenceDay) - calendarDayNumber(messageDay);
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  };
  if (daysAgo === 0) return formatInstant(value, locale, timeOptions);
  if (daysAgo === 1) {
    const relativeDay = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
    return `${capitalizeLabel(relativeDay, locale)} ${formatInstant(value, locale, timeOptions)}`;
  }
  if (daysAgo > 1 && daysAgo < 7) {
    return formatInstant(value, locale, { weekday: "short", ...timeOptions });
  }

  return formatInstant(value, locale, {
    ...(messageDay.year === referenceDay.year ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    ...timeOptions,
  });
}

export function formatMessageClockTime(
  value: string,
  locale?: Intl.LocalesArgument,
  timeZone?: string
): string {
  /* A header-less row sits under a header that already says the day, and its
     gutter is one avatar wide: the clock alone fits there on one line. */
  if (!Number.isFinite(new Date(value).getTime())) return value;
  return formatInstant(value, locale, { hour: "numeric", minute: "2-digit", timeZone });
}

function capitalizeLabel(value: string, locale?: Intl.LocalesArgument): string {
  const [first, ...rest] = Array.from(value);
  return first ? `${first.toLocaleUpperCase(locale)}${rest.join("")}` : value;
}

type MessageCalendarDate = {
  year: number;
  month: number;
  day: number;
};

function calendarDayNumber(value: MessageCalendarDate): number {
  return Date.UTC(value.year, value.month - 1, value.day) / 86_400_000;
}

function messageCalendarDate(value: Date, timeZone?: string): MessageCalendarDate | null {
  if (!Number.isFinite(value.getTime())) return null;
  if (!timeZone) {
    return {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
    };
  }

  const parts = dateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone,
  }).formatToParts(value);
  const partNumber = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = partNumber("year");
  const month = partNumber("month");
  const day = partNumber("day");
  return year && month && day ? { year, month, day } : null;
}

export function filterHistoryForChannel<T extends ChannelHistoryLike>(
  channelId: string,
  messages: T[]
): T[] {
  return messages.filter((message) => message.channelId === channelId);
}

export function sortChannelHistory<T extends ChannelHistoryLike>(messages: T[]): T[] {
  return [...messages].sort((a, b) => {
    if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    const byTime = Date.parse(a.sentAt) - Date.parse(b.sentAt);
    if (byTime !== 0) return byTime;
    return a.messageId.localeCompare(b.messageId);
  });
}

/**
 * A refresh that produced the identical window (same messages, edit and
 * recall markers, in the same order) must not re-render the timeline.
 */
export function sameChannelHistoryWindow<
  T extends ChannelHistoryLike & { editedAt?: string; recalledAt?: string },
>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.messageId !== b.messageId ||
      a.editedAt !== b.editedAt ||
      a.recalledAt !== b.recalledAt
    ) return false;
  }
  return true;
}

export function mergeChannelHistory<T extends ChannelHistoryLike>(
  channelId: string,
  current: T[],
  incoming: T[]
): T[] {
  const byId = new Map<string, T>();
  for (const message of filterHistoryForChannel(channelId, current)) {
    byId.set(message.messageId, message);
  }
  for (const message of filterHistoryForChannel(channelId, incoming)) {
    byId.set(message.messageId, message);
  }
  return sortChannelHistory(Array.from(byId.values()));
}

export function compactChannelHistoryWindow<T extends ChannelHistoryLike>(
  channelId: string,
  messages: T[],
  hasOlderMessages: boolean,
  maxMessages: number,
): { messages: T[]; hasOlderMessages: boolean } {
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) {
    throw new Error("invalid Channel history cache limit");
  }
  const sorted = sortChannelHistory(filterHistoryForChannel(channelId, messages));
  return {
    messages: sorted.slice(-maxMessages),
    hasOlderMessages: hasOlderMessages || sorted.length > maxMessages,
  };
}
