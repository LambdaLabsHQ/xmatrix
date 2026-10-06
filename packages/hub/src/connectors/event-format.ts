/*
 * Shared shaping for provider deliveries (docs/design/connector-platform.md
 * §3.3). Delivery content is untrusted: it is quoted into a bounded message,
 * a mention inside it never addresses anyone, and it cannot open markdown that
 * outlives its line or fence.
 */

import type { ConnectorEvent } from "./provider";

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** `{}` for an empty body; `undefined` when the body is not a JSON object. */
export function parseJsonObject(rawBody: string): JsonRecord | undefined {
  try {
    const parsed = rawBody.trim() ? JSON.parse(rawBody) as unknown : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : undefined;
  } catch {
    return undefined;
  }
}

export function shieldDeliveryText(value: string): string {
  return value.replace(/[@＠](?=[\p{L}\p{N}_])/gu, "@​");
}

export function oneLine(value: string, maximum = 200): string {
  const flat = shieldDeliveryText(value.replace(/`/gu, "'").replace(/\s+/gu, " ").trim());
  return flat.length > maximum ? `${flat.slice(0, maximum - 1)}…` : flat;
}

export function safeUrl(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/* A fenced block cannot be closed from inside: any backtick run as long as the
   fence is shortened. */
export function fenced(content: string, language = ""): string {
  return `\`\`\`${language}\n${shieldDeliveryText(content.replace(/`{3,}/gu, "``"))}\n\`\`\``;
}

/** A quoted excerpt of free text (a comment, a message), bounded and fenced. */
export function excerpt(value: unknown, maximum = 600): string | undefined {
  const content = text(value);
  if (!content) return undefined;
  return fenced(content.length > maximum ? `${content.slice(0, maximum)}\n…` : content);
}

/** Lower-case and bounded, so a source ref matches what a Channel subscribed. */
export function sourceToken(value: unknown): string {
  return text(value).toLowerCase().slice(0, 200);
}

/**
 * The message for one event: a bold provider label and one-line title, the
 * link, then optional detail lines (already shaped by the caller).
 */
export function eventMessage(input: { provider: string; title: string; url?: string; details?: (string | undefined)[] }): string {
  return [`**${input.provider}** — ${oneLine(input.title)}`, ...(input.url ? [input.url] : []),
    ...(input.details ?? []).filter((line): line is string => Boolean(line))].join("\n");
}

/**
 * One provider event: its routing fields, a summary bounded to 200
 * characters, and its Channel message built by `eventMessage`, linking `url`.
 */
export function connectorEvent(input: {
  eventId: string; sourceRef: string; feature: string; summary: string;
  provider: string; title: string; url?: string | undefined; details?: (string | undefined)[];
}): ConnectorEvent {
  const { eventId, sourceRef, feature, summary, url } = input;
  return { eventId, sourceRef, feature, summary: summary.slice(0, 200),
    body: eventMessage(input), ...(url ? { url } : {}) };
}

export function lowerHeader(headers: Headers, name: string): string {
  return headers.get(name)?.trim() ?? "";
}
