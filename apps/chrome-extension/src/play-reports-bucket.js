// Detects a Google Play Console Cloud Storage export bucket ID (`pubsite_prod_rev_*`)
// from an open Play Console tab. Only plain bucket IDs matching Google Play's export
// naming format leave the page; cookies, tokens, storage and other page contents are
// never read or transmitted.

export const PLAY_BUCKET_PATTERN = /^pubsite_prod(?:_rev)?_[0-9]{6,30}$/u;
const PLAY_BUCKET_GLOBAL = /\b(pubsite_prod(?:_rev)?_[0-9]{6,30})\b/gu;
const MAX_BUCKETS = 10;
const MAX_SCAN_TEXT = 500_000;

/** Strictly https://play.google.com/console (or any route under it). */
export function isPlayConsoleUrl(href) {
  if (typeof href !== "string" || !href) return false;
  try {
    const url = new URL(href);
    return url.protocol === "https:"
      && url.hostname === "play.google.com"
      && (url.pathname === "/console" || url.pathname.startsWith("/console/"));
  } catch {
    return false;
  }
}

/** Whether a Play Console address is already inside its Download reports section. */
export function isPlayDownloadReportsUrl(href) {
  if (!isPlayConsoleUrl(href)) return false;
  try {
    return /\/download-reports(?:\/|$)/u.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

/** Direct link to Download reports for the same Play Console account/developer when known. */
export function playDownloadReportsUrl(href) {
  if (isPlayConsoleUrl(href)) {
    try {
      const { pathname } = new URL(href);
      const multi = /^\/console\/u\/(\d+)\/developers\/(\d+)(?:\/|$)/u.exec(pathname);
      if (multi) return `https://play.google.com/console/u/${multi[1]}/developers/${multi[2]}/download-reports/statistics`;
      const single = /^\/console\/developers\/(\d+)(?:\/|$)/u.exec(pathname);
      if (single) return `https://play.google.com/console/developers/${single[1]}/download-reports/statistics`;
    } catch {
      // Fall through to the generic Play Console landing page.
    }
  }
  return "https://play.google.com/console/developers";
}

function sortBuckets(buckets) {
  return [...buckets].sort((a, b) => {
    const aRev = a.startsWith("pubsite_prod_rev_") ? 0 : 1;
    const bRev = b.startsWith("pubsite_prod_rev_") ? 0 : 1;
    return aRev !== bRev ? aRev - bRev : a.localeCompare(b);
  });
}

/** Extracts unique Play Console export bucket IDs from plain text or gs:// URIs. */
export function extractPlayBucketsFromText(text) {
  if (typeof text !== "string" || !text) return [];
  const slice = text.length > MAX_SCAN_TEXT ? text.slice(0, MAX_SCAN_TEXT) : text;
  const found = new Set();
  for (const match of slice.matchAll(PLAY_BUCKET_GLOBAL)) {
    found.add(match[1]);
    if (found.size >= MAX_BUCKETS) break;
  }
  return sortBuckets(found);
}

/**
 * Self-contained page function injected into a Play Console tab by chrome.scripting.
 * Runs inside the tab and returns ONLY matched `pubsite_prod_*` bucket IDs (never
 * cookies, localStorage, sessionStorage, scripts, password fields, or page text).
 */
export function scanDocumentForPlayBuckets() {
  if (typeof location === "undefined" || typeof document === "undefined") return [];
  if (location.origin !== "https://play.google.com") return [];
  if (location.pathname !== "/console" && !location.pathname.startsWith("/console/")) return [];

  const re = /\b(pubsite_prod(?:_rev)?_[0-9]{6,30})\b/gu;
  const found = new Set();
  const MAX = 10;
  const MAX_CHARS = 250_000;
  const MAX_NODES = 5_000;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const SAFE_ATTRS = ["aria-label", "title", "data-clipboard-text", "data-copy-text", "data-value", "data-uri"];

  const scanText = (value) => {
    if (typeof value !== "string" || !value || found.size >= MAX) return;
    const slice = value.length > MAX_CHARS ? value.slice(0, MAX_CHARS) : value;
    for (const match of slice.matchAll(re)) {
      found.add(match[1]);
      if (found.size >= MAX) break;
    }
  };

  scanText(document.body?.innerText);

  const stack = document.body ? [document.body] : [];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_NODES && found.size < MAX) {
    const el = stack.pop();
    if (!el || SKIP_TAGS.has(el.tagName)) continue;
    visited += 1;

    if (el.tagName === "A") scanText(el.getAttribute?.("href"));
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "password") {
      scanText(el.value);
      scanText(el.getAttribute?.("placeholder"));
    }
    if (typeof el.getAttribute === "function") {
      for (const attr of SAFE_ATTRS) scanText(el.getAttribute(attr));
    }
    if (el.shadowRoot) {
      scanText(el.shadowRoot.textContent);
      const shadowChildren = el.shadowRoot.children;
      if (shadowChildren) {
        for (let i = shadowChildren.length - 1; i >= 0; i -= 1) stack.push(shadowChildren[i]);
      }
    }
    const children = el.children;
    if (children) {
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }

  return [...found];
}

function sanitizeBuckets(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = new Set();
  for (const item of raw) {
    if (typeof item === "string" && PLAY_BUCKET_PATTERN.test(item)) {
      clean.add(item);
      if (clean.size >= MAX_BUCKETS) break;
    }
  }
  return sortBuckets(clean);
}

/** Reads validated `pubsite_prod_*` bucket IDs from one Play Console tab. */
export async function readPlayBucketsFromTab(chromeApi, tabId) {
  if (!Number.isInteger(tabId)) return [];
  try {
    const [result] = await chromeApi.scripting.executeScript({
      target: { tabId },
      func: scanDocumentForPlayBuckets,
    });
    return sanitizeBuckets(result?.result);
  } catch {
    return [];
  }
}

/**
 * Finds `pubsite_prod_*` bucket IDs across currently open Play Console tabs.
 * Used when the trusted xMatrix Web app asks to sync from an open Play Console tab.
 */
export async function findOpenPlayConsoleBuckets(chromeApi, { origins = ["https://*/*"] } = {}) {
  if (!chromeApi.permissions?.contains || !(await chromeApi.permissions.contains({ origins }))) {
    return { status: "no-permission", buckets: [] };
  }
  const tabs = await chromeApi.tabs.query({ url: ["https://play.google.com/console", "https://play.google.com/console/*"] });
  const candidates = tabs.filter((tab) => tab?.id !== undefined && isPlayConsoleUrl(tab.url));
  if (candidates.length === 0) return { status: "no-tab", buckets: [] };

  candidates.sort((a, b) => {
    const aReports = isPlayDownloadReportsUrl(a.url) ? 0 : 1;
    const bReports = isPlayDownloadReportsUrl(b.url) ? 0 : 1;
    if (aReports !== bReports) return aReports - bReports;
    return (b.active ? 1 : 0) - (a.active ? 1 : 0);
  });

  const found = new Set();
  for (const tab of candidates.slice(0, 5)) {
    const buckets = await readPlayBucketsFromTab(chromeApi, tab.id);
    for (const bucket of buckets) {
      found.add(bucket);
      if (found.size >= MAX_BUCKETS) break;
    }
    if (found.size >= MAX_BUCKETS) break;
  }

  if (found.size > 0) return { status: "found", buckets: sortBuckets(found) };
  return {
    status: "not-found",
    buckets: [],
    downloadReportsUrl: playDownloadReportsUrl(candidates[0].url),
  };
}
