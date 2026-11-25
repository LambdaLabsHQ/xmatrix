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

  const storedLocal = chromeApi.storage?.local?.get ? await chromeApi.storage.local.get(null).catch(() => ({})) : {};
  const storedSession = chromeApi.storage?.session?.get ? await chromeApi.storage.session.get(null).catch(() => ({})) : {};
  const stored = { ...storedSession, ...storedLocal };
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

/**
 * The conversation bound to this browser tab (one tab = one conversation thread).
 * Stored in `chrome.storage.local` so extension reloads/updates preserve open tabs'
 * threads; cleared when a tab closes or on browser startup for non-existent tabs.
 */
export async function tabPageThread(chromeApi, tabId) {
  if (!Number.isInteger(tabId)) return null;
  const key = `askThread:${tabId}`;
  if (chromeApi.storage?.local?.get) {
    const { [key]: localThread } = await chromeApi.storage.local.get(key);
    if (localThread?.channelId && localThread?.spaceId) return localThread;
  }
  if (chromeApi.storage?.session?.get) {
    const { [key]: sessionThread } = await chromeApi.storage.session.get(key);
    if (sessionThread?.channelId && sessionThread?.spaceId) return sessionThread;
  }
  return null;
}

/** Persists a tab's active conversation in `chrome.storage.local` so extension reloads keep it. */
export async function setTabThread(chromeApi, tabId, thread) {
  if (!Number.isInteger(tabId) || !thread?.channelId || !thread?.spaceId) return;
  const key = `askThread:${tabId}`;
  if (chromeApi.storage?.local?.set) await chromeApi.storage.local.set({ [key]: thread });
  if (chromeApi.storage?.session?.remove) await chromeApi.storage.session.remove(key).catch(() => undefined);
}

/** Clears a tab's bound conversation (when clicking "+" New conversation or closing the tab). */
export async function clearTabThread(chromeApi, tabId) {
  if (!Number.isInteger(tabId)) return;
  const key = `askThread:${tabId}`;
  if (chromeApi.storage?.local?.remove) await chromeApi.storage.local.remove(key).catch(() => undefined);
  if (chromeApi.storage?.session?.remove) await chromeApi.storage.session.remove(key).catch(() => undefined);
}

/** Clears all `askThread:*` entries on browser startup because Chrome reassigns tab IDs on restart. */
export async function clearAllTabThreads(chromeApi) {
  const removed = [];
  if (chromeApi.storage?.local?.get && chromeApi.storage?.local?.remove) {
    const stored = await chromeApi.storage.local.get(null);
    const keys = Object.keys(stored ?? {}).filter((key) => key.startsWith("askThread:"));
    if (keys.length > 0) {
      await chromeApi.storage.local.remove(keys);
      removed.push(...keys);
    }
  }
  if (chromeApi.storage?.session?.get && chromeApi.storage?.session?.remove) {
    const stored = await chromeApi.storage.session.get(null).catch(() => ({}));
    const keys = Object.keys(stored ?? {}).filter((key) => key.startsWith("askThread:"));
    if (keys.length > 0) {
      await chromeApi.storage.session.remove(keys).catch(() => undefined);
    }
  }
  return removed;
}

/** Moves a tab's bound thread when Chrome replaces its tab ID (e.g. prerender or discard/restore). */
export async function migrateTabThread(chromeApi, removedTabId, addedTabId) {
  if (!Number.isInteger(removedTabId) || !Number.isInteger(addedTabId) || removedTabId === addedTabId) return false;
  const thread = await tabPageThread(chromeApi, removedTabId);
  if (!thread) return false;
  await setTabThread(chromeApi, addedTabId, thread);
  await clearTabThread(chromeApi, removedTabId);
  return true;
}

/** Removes stale `askThread:<tabId>` entries whose tabs no longer exist. */
export async function pruneClosedTabThreads(chromeApi) {
  if (!chromeApi.storage?.local?.get || !chromeApi.storage?.local?.remove) return [];
  const [stored, tabs] = await Promise.all([
    chromeApi.storage.local.get(null),
    chromeApi.tabs?.query ? chromeApi.tabs.query({}) : Promise.resolve([]),
  ]);
  const liveIds = new Set(tabs.filter((tab) => Number.isInteger(tab?.id)).map((tab) => tab.id));
  const stale = Object.keys(stored ?? {}).filter((key) => {
    if (!key.startsWith("askThread:")) return false;
    const id = Number(key.slice("askThread:".length));
    return !Number.isInteger(id) || !liveIds.has(id);
  });
  if (stale.length > 0) await chromeApi.storage.local.remove(stale);
  return stale;
}

/**
 * Finds the open tab bound to `channelId` (via `askThread:*` in storage.local, or Recent fallback).
 * When multiple tabs are bound to the same `channelId`, prefers the active foreground one.
 * Returns `{ tab, hasBinding }` so callers distinguish "no page for this conversation" from "tab closed".
 */
export async function findConversationTab(chromeApi, channelId) {
  if (typeof channelId !== "string" || !channelId) return { tab: null, hasBinding: false };
  const storedLocal = chromeApi.storage?.local?.get ? await chromeApi.storage.local.get(null).catch(() => ({})) : {};
  const liveBound = [];
  let hasBinding = false;
  let fallbackPage = "";
  for (const [key, thread] of Object.entries(storedLocal ?? {})) {
    if (!key.startsWith("askThread:") || thread?.channelId !== channelId) continue;
    hasBinding = true;
    const tabId = Number(key.slice("askThread:".length));
    const tab = Number.isInteger(tabId) ? await chromeApi.tabs.get(tabId).catch(() => null) : null;
    if (tab?.id !== undefined && capturableUrl(tab.url ?? "")) {
      liveBound.push(tab);
    } else if (!fallbackPage && thread.page) {
      fallbackPage = thread.page;
    }
  }
  if (liveBound.length > 0) {
    return { tab: liveBound.find((tab) => tab.active) ?? liveBound[0], hasBinding: true };
  }
  if (hasBinding) {
    const open = fallbackPage ? await findTabForPage(chromeApi, fallbackPage).catch(() => null) : null;
    return { tab: open, hasBinding: true };
  }
  const recentThreads = Array.isArray(storedLocal?.recentThreads) ? storedLocal.recentThreads : [];
  const suffix = `/channels/${encodeURIComponent(channelId)}`;
  const recent = recentThreads.find((item) => typeof item?.path === "string" && item.path.endsWith(suffix));
  const href = recent && capturableUrl(String(recent.href ?? ""));
  if (!href) return { tab: null, hasBinding: false };
  const open = await findTabForPage(chromeApi, href).catch(() => null);
  return { tab: open, hasBinding: true };
}

/**
 * Privacy-bounded tab selection for `xmatrix browse` (`current` / `conversation`):
 * 1. Prefer an open tab explicitly bound to `channelId` (active tab first if multiple).
 * 2. If `channelId` has no binding, allow reading the foreground active tab ONLY when
 *    that tab itself has an open xMatrix side panel (never a tab only bound to a different conversation).
 * 3. Otherwise refuse immediately (`no-page` or `not-open`) — never read an unrelated tab.
 */
export async function selectBrowserReadTab(chromeApi, { channelId = "", openPanelTabIds = new Set() } = {}) {
  if (typeof channelId === "string" && channelId) {
    const bound = await findConversationTab(chromeApi, channelId);
    if (bound.hasBinding) {
      return bound.tab?.id !== undefined
        ? { tab: bound.tab, refusal: null }
        : { tab: null, refusal: "not-open" };
    }
  }
  const [front] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (!front?.id || !capturableUrl(front.url ?? "")) return { tab: null, refusal: "no-page" };
  const hasOpenPanel = openPanelTabIds instanceof Set || openPanelTabIds instanceof Map
    ? openPanelTabIds.has(front.id)
    : Array.isArray(openPanelTabIds) && openPanelTabIds.includes(front.id);
  if (hasOpenPanel) {
    return { tab: front, refusal: null };
  }
  return { tab: null, refusal: "no-page" };
}

/**
 * A tab as an Agent reads it: its accessibility snapshot (`src/page-snapshot.js`),
 * at most 200,000 characters; empty where it cannot be read.
 */
export async function readTabSnapshot(chromeApi, tabId) {
  try {
    await chromeApi.scripting.executeScript({ target: { tabId }, files: ["src/page-snapshot.js"] });
    const [result] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: (maxChars) => globalThis.__xmatrixPageSnapshot?.(maxChars) ?? "",
      args: [200_000],
    });
    return typeof result?.result === "string" ? result.result : "";
  } catch {
    return "";
  }
}
