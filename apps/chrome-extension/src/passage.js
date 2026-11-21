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
  return { text: clip(text, MAX_TEXT), label: clip(String(title ?? "").replace(/\s+/gu, " "), MAX_LABEL), href, target };
}
