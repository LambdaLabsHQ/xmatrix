// Turns what the person captured from a page into the message they send.

const MAX_TITLE = 300;
const MAX_SELECTION = 8000;
const MAX_NOTE = 8000;

function clip(text, max) {
  const value = String(text ?? "").replace(/\r\n?/gu, "\n").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Only web pages are captured: the extension's own and the browser's pages carry nothing to share. */
export function capturableUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function quote(text) {
  return text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

/** Keeps a title on one line and out of Markdown link syntax. */
function linkText(title) {
  return title.replace(/\s+/gu, " ").replace(/[[\]]/gu, "");
}

/**
 * The message body: the person's note first, then a link to the page and, when
 * they chose one, the selected text as a quote. The quoted page text is the
 * page's content, shown as such, never the person's instruction.
 */
export function composeMessage({ note, title, url, selection, includePage = true }) {
  const parts = [];
  const text = clip(note, MAX_NOTE);
  if (text) parts.push(text);
  const pageUrl = includePage ? capturableUrl(url) : null;
  if (pageUrl) {
    const name = linkText(clip(title, MAX_TITLE));
    parts.push(name ? `[${name}](${pageUrl})` : pageUrl);
  }
  const excerpt = pageUrl ? clip(selection, MAX_SELECTION) : "";
  if (excerpt) parts.push(quote(excerpt));
  return parts.join("\n\n");
}
