/**
 * Inline marks for a one-line conversation preview.
 *
 * The catalog stores the message source, truncated, so the row can show the
 * same bold, italic, code, and strike the thread renders. Block structure
 * stays text: the row is 18px tall. HTML stays text too — message bodies are
 * untrusted, and this never builds markup from them.
 */

export type PreviewMark = "text" | "strong" | "em" | "code" | "strike";

export interface PreviewSegment {
  mark: PreviewMark;
  text: string;
}

export interface ChannelPreviewSource {
  lastMessage?: { from: { label: string }; bodyPreview?: string } | null;
  topic?: string | null;
  summary?: string | null;
}

export type ChannelPreviewModel =
  | { kind: "plain"; text: string }
  | { kind: "rich"; label: string; body: string };

const ESCAPED = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", "-", ".", "!", "~"]);

/** The row's second line: author and body when there is one, otherwise the channel's own line. */
export function channelPreviewModel(channel: ChannelPreviewSource): ChannelPreviewModel {
  const last = channel.lastMessage;
  if (last?.bodyPreview) return { kind: "rich", label: last.from.label, body: last.bodyPreview };
  if (last) return { kind: "plain", text: last.from.label };
  return { kind: "plain", text: channel.topic || channel.summary || "No messages yet" };
}

export function inlinePreviewSegments(source: string): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  let textStart = 0;
  let index = 0;

  const pushText = (end: number) => {
    if (end > textStart) segments.push({ mark: "text", text: source.slice(textStart, end) });
  };

  while (index < source.length) {
    const escaped = escapedChar(source, index);
    if (escaped) {
      pushText(index);
      segments.push({ mark: "text", text: escaped });
      index += 2;
      textStart = index;
      continue;
    }
    const token = readToken(source, index);
    if (!token) {
      index += 1;
      continue;
    }
    pushText(index);
    if (token.mark === "link" || token.mark === "image") {
      segments.push(...inlinePreviewSegments(token.text));
    } else {
      segments.push({ mark: token.mark, text: token.text });
    }
    index = token.end;
    textStart = index;
  }
  pushText(source.length);
  return mergeText(segments);
}

interface Token {
  mark: PreviewMark | "link" | "image";
  text: string;
  end: number;
}

function escapedChar(source: string, index: number): string | null {
  if (source[index] !== "\\" || index + 1 >= source.length) return null;
  const next = source[index + 1] ?? "";
  return ESCAPED.has(next) ? next : null;
}

function readToken(source: string, index: number): Token | null {
  return readCode(source, index)
    ?? readWrapped(source, index, "***", "strong")
    ?? readWrapped(source, index, "**", "strong")
    ?? readWrapped(source, index, "___", "strong")
    ?? readWrapped(source, index, "__", "strong")
    ?? readWrapped(source, index, "~~", "strike")
    ?? readMedia(source, index)
    ?? readEmphasis(source, index);
}

function readCode(source: string, index: number): Token | null {
  if (source[index] !== "`") return null;
  const close = source.indexOf("`", index + 1);
  if (close <= index + 1) return null;
  const text = source.slice(index + 1, close);
  if (text.includes("\n")) return null;
  return { mark: "code", text, end: close + 1 };
}

/** A paired delimiter whose content has no leading or trailing whitespace. */
function readWrapped(source: string, index: number, delimiter: string, mark: PreviewMark): Token | null {
  if (!source.startsWith(delimiter, index)) return null;
  const contentStart = index + delimiter.length;
  const lineEnd = lineBoundary(source, contentStart);
  let cursor = contentStart;
  while (cursor < lineEnd) {
    const close = source.indexOf(delimiter, cursor);
    if (close < 0 || close >= lineEnd) return null;
    const text = source.slice(contentStart, close);
    if (text.length > 0 && !edgeWhitespace(text)) {
      return { mark, text, end: close + delimiter.length };
    }
    cursor = close + delimiter.length;
  }
  return null;
}

function readMedia(source: string, index: number): Token | null {
  const image = source[index] === "!";
  const start = image ? index + 1 : index;
  if (source[start] !== "[") return null;
  const labelEnd = source.indexOf("]", start + 1);
  if (labelEnd < 0) return null;
  if (source[labelEnd + 1] !== "(") return null;
  const urlEnd = source.indexOf(")", labelEnd + 2);
  if (urlEnd < 0) return null;
  const text = source.slice(start + 1, labelEnd);
  if (!text.trim() || text.includes("\n") || source.slice(labelEnd + 2, urlEnd).includes("\n")) return null;
  return { mark: image ? "image" : "link", text, end: urlEnd + 1 };
}

function readEmphasis(source: string, index: number): Token | null {
  const marker = source[index];
  if (marker !== "*" && marker !== "_") return null;
  if (marker === "_" && wordChar(source[index - 1])) return null;
  if (source[index + 1] === marker) return null;
  const lineEnd = lineBoundary(source, index + 1);
  for (let cursor = index + 1; cursor < lineEnd; cursor += 1) {
    if (source[cursor] !== marker || source[cursor + 1] === marker || source[cursor - 1] === marker) continue;
    if (marker === "_" && wordChar(source[cursor + 1])) continue;
    const text = source.slice(index + 1, cursor);
    if (text.length > 0 && !edgeWhitespace(text)) return { mark: "em", text, end: cursor + 1 };
  }
  return null;
}

function lineBoundary(source: string, from: number): number {
  const newline = source.indexOf("\n", from);
  return newline < 0 ? source.length : newline;
}

function edgeWhitespace(text: string): boolean {
  return /^\s/u.test(text) || /\s$/u.test(text);
}

function wordChar(char: string | undefined): boolean {
  return Boolean(char && /[\p{L}\p{N}_]/u.test(char));
}

function mergeText(segments: PreviewSegment[]): PreviewSegment[] {
  const merged: PreviewSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = merged[merged.length - 1];
    if (previous?.mark === "text" && segment.mark === "text") previous.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}
