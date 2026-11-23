/**
 * The page a person was looking at in Chrome when they wrote a message from
 * the xMatrix extension's side panel. It rides in the message's metadata, not
 * its body (an Agent selection's offsets are into the body): the App shows it
 * under the message, and an Agent's runtime tells the Agent, which can read
 * the page with `xmatrix browse`.
 */
export const BROWSER_PAGE_METADATA_KEY = "browserPage";

export type BrowserPage = { title: string; href: string };

const MAX_TITLE = 300;
const MAX_HREF = 2_000;

/** The page a message was written beside; null for any other message or a malformed value. */
export function browserPageOf(metadata: unknown): BrowserPage | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const page = (metadata as Record<string, unknown>)[BROWSER_PAGE_METADATA_KEY];
  if (!page || typeof page !== "object" || Array.isArray(page)) return null;
  const { title, href } = page as Record<string, unknown>;
  if (typeof href !== "string" || href.length > MAX_HREF || !/^https?:\/\//iu.test(href)) return null;
  try {
    new URL(href);
  } catch {
    return null;
  }
  return { title: typeof title === "string" ? title.trim().slice(0, MAX_TITLE) : "", href };
}

/** Message metadata saying which page the message was written beside. */
export function browserPageMetadata(page: BrowserPage): Record<string, unknown> {
  return { [BROWSER_PAGE_METADATA_KEY]: { title: page.title.slice(0, MAX_TITLE), href: page.href } };
}
