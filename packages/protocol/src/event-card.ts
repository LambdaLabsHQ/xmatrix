/*
 * An App event as a card in the message stream. The Hub writes it on the
 * message's metadata; the Web draws it in the reader's own language, so every
 * text comes in each language a reader can choose. Text an App wrote itself (a
 * decline message, an id) is the same in both.
 */

export const EVENT_CARD_METADATA_KEY = "xmatrixEventCard";

export interface EventCardWords { en: string; zh: string }

export interface EventCard {
  /** How it ended: `bad` needs someone's attention, `good` and `plain` do not. */
  tone: "good" | "bad" | "plain";
  /** What happened; the card's first and largest line. */
  title: EventCardWords;
  /** The one figure the event is about, beside the title: an amount. */
  value?: string;
  /** Why, in a sentence, under the title. */
  note?: EventCardWords;
  /** Small facts that tell this event from the next: a status, an account. */
  meta: EventCardWords[];
  /** The event's page at the App. */
  link?: { url: string; label: EventCardWords };
}

function words(value: unknown): EventCardWords | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { en, zh } = value as Record<string, unknown>;
  return typeof en === "string" && en && typeof zh === "string" && zh ? { en, zh } : undefined;
}

/** The card on a message's metadata, or nothing when it is absent or not one this build draws. */
export function eventCardOf(metadata: unknown): EventCard | undefined {
  const card = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[EVENT_CARD_METADATA_KEY] : undefined;
  if (!card || typeof card !== "object") return undefined;
  const record = card as Record<string, unknown>;
  const title = words(record.title);
  if (!title || (record.tone !== "good" && record.tone !== "bad" && record.tone !== "plain")) return undefined;
  const link = record.link && typeof record.link === "object" ? record.link as Record<string, unknown> : undefined;
  const label = words(link?.label);
  const note = words(record.note);
  return { tone: record.tone, title,
    ...(typeof record.value === "string" && record.value ? { value: record.value } : {}),
    ...(note ? { note } : {}),
    meta: Array.isArray(record.meta) ? record.meta.map(words).filter((item): item is EventCardWords => Boolean(item)) : [],
    ...(typeof link?.url === "string" && link.url.startsWith("https://") && label ? { link: { url: link.url, label } } : {}) };
}
