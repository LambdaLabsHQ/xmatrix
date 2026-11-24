// Finding and focusing the browser tab that shows a web page a conversation came from.
// Shared by the side panel and the service worker's externally_connectable listener for the Web app.

import { capturableUrl } from "./passage.js";

const WEB_APP_ORIGINS = new Set(["https://xmatrix.sh", "https://beta.xmatrix.sh"]);

/** A page as a place to talk about: its address without the fragment. */
export function pageKey(href) {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.toString();
  } catch {
    return href;
  }
}

/** Only xMatrix's own Web app origins may ask the extension to switch back to a tab. */
export function isTrustedWebAppOrigin(origin, { allowLocalhost = false } = {}) {
  if (typeof origin !== "string" || !origin) return false;
  if (WEB_APP_ORIGINS.has(origin)) return true;
  if (!allowLocalhost) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function tabMatchesPage(tab, target) {
  const href = capturableUrl(tab?.url ?? "");
  return Boolean(href && pageKey(href) === target);
}

/**
 * Picks the open tab showing `href`:
 * 1. `preferredTabId` (the side panel's own tab) when its visible URL matches;
 * 2. Any open tab whose visible URL matches (active tab first);
 * 3. Without web-page host permission other tabs' URLs are hidden, so fall back to an open tab
 *    that still has `askThread:<tabId>` recorded for this page (and no contradicting visible URL).
 */
export async function findTabForPage(chromeApi, href, { preferredTabId = null } = {}) {
  const cleanHref = capturableUrl(href);
  if (!cleanHref) return null;
  const target = pageKey(cleanHref);

  if (Number.isInteger(preferredTabId)) {
    const own = await chromeApi.tabs.get(preferredTabId).catch(() => null);
    if (own?.id !== undefined && tabMatchesPage(own, target)) return own;
  }

  const allTabs = await chromeApi.tabs.query({});
  const showing = allTabs.filter((tab) => tab?.id !== undefined && tabMatchesPage(tab, target));
  if (showing.length > 0) return showing.find((tab) => tab.active) ?? showing[0];

  if (!chromeApi.storage?.session?.get) return null;
  const stored = await chromeApi.storage.session.get(null);
  const byId = new Map(allTabs.filter((tab) => tab?.id !== undefined).map((tab) => [tab.id, tab]));
  const remembered = [];
  for (const [key, thread] of Object.entries(stored ?? {})) {
    if (!key.startsWith("askThread:") || thread?.page !== target) continue;
    const tabId = Number(key.slice("askThread:".length));
    const tab = byId.get(tabId);
    if (!tab) continue;
    // If Chrome exposed the tab's URL and it no longer matches, the person navigated away.
    const visibleHref = capturableUrl(tab.url ?? "");
    if (visibleHref && pageKey(visibleHref) !== target) continue;
    remembered.push(tab);
  }
  if (remembered.length === 0) return null;
  return remembered.find((tab) => tab.id === preferredTabId)
    ?? remembered.find((tab) => tab.active)
    ?? remembered[0];
}

/**
 * Brings `href` into view: activates an open tab showing it and focuses its window,
 * opening a new tab only when no matching tab is open any more.
 */
export async function showWebPage(chromeApi, href, { preferredTabId = null } = {}) {
  const cleanHref = capturableUrl(href);
  if (!cleanHref) return false;
  const tab = await findTabForPage(chromeApi, cleanHref, { preferredTabId });
  if (!tab?.id) {
    await chromeApi.tabs.create({ url: cleanHref });
    return true;
  }
  await chromeApi.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) {
    await chromeApi.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  }
  return true;
}
