// What the person picks on a page, as the side panel hands it to the app
// (apps/web src/lib/extension-embed.ts validates the same bounds).

const MAX_TEXT = 20_000;
const MAX_LABEL = 300;

/** Only web pages are captured: the browser's and extensions' own pages carry nothing to share. */
export function capturableUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function clip(value, max) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A passage of a page, or the page itself when nothing is selected, bound for
 * the open conversation (`current`) or a new one (`new`). Null for a page that
 * is not on the web.
 */
export function pagePassage({ text, title, url, target }) {
  const href = capturableUrl(url);
  if (!href || (target !== "current" && target !== "new")) return null;
  return { text: clip(text, MAX_TEXT), label: clip(pageTitle(title), MAX_LABEL), href, target };
}

/**
 * A page's title as a source label: one line, without the unread counts sites
 * put in front of it ("(3) Inbox", "(99+ 封私信 / 1 条消息) 首页 - 知乎").
 */
export function pageTitle(title) {
  const line = String(title ?? "").replace(/\s+/gu, " ").trim();
  const bare = line.replace(/^(?:\(\s*\d[^()]{0,40}\)\s*)+/u, "");
  return bare || line;
}

/** A discussion is named by its passage until its first message names it (apps/web selection-discussion.ts). */
export function discussionTitle(quote) {
  const line = quote.trim().replace(/\s+/gu, " ");
  return `“${line.length > 60 ? `${line.slice(0, 59)}…` : line}”`;
}
