// The side panel: the xMatrix app in a frame, signed in with the extension's
// session, with a bar for the page beside it.
//
// The app is packaged with the extension (app/, built from apps/web by
// scripts/build-app.mjs), so opening the panel loads nothing from the Web. It
// asks for its session over postMessage (apps/web src/lib/extension-embed.ts);
// this page answers only its own frame at the extension's origin, and posts
// only to that origin. Passages picked on a page (the context menu, the
// selection button, this bar) are handed to the app once it says it is ready.

import { capturableUrl, pageTitle } from "./passage.js";

const PROTOCOL = "xmatrix-embed/1";
const APP_ORIGIN = window.location.origin;
const APP_PAGE = "/app/index.html";
const WEB_ORIGINS = ["https://*/*", "http://*/*"];
const $ = (id) => document.getElementById(id);
const views = ["view-signed-out", "view-signing-in", "view-update", "view-quick-select", "view-app"];

function show(view) {
  for (const id of views) $(id).hidden = id !== view;
}

async function ask(type, args) {
  const answer = await chrome.runtime.sendMessage({ type, args });
  if (!answer?.ok) throw new Error(answer?.error ?? "xMatrix could not be reached.");
  return answer.value;
}

function fail(element, error) {
  element.textContent = error instanceof Error ? error.message : String(error);
  element.hidden = false;
}

// ---- The app frame.

let appReady = false;

function appWindow() {
  return $("app").contentWindow;
}

function postToApp(message) {
  appWindow()?.postMessage({ protocol: PROTOCOL, ...message }, APP_ORIGIN);
}

/** The window this panel is beside: a conversation started from a page in it opens here. */
let windowIdPromise = null;
function panelWindow() {
  windowIdPromise ??= chrome.windows.getCurrent().then((window) => window.id).catch(() => undefined);
  return windowIdPromise;
}

/** Loads the app, straight onto a conversation the extension just started when there is one. */
let opening = false;
async function openApp() {
  if (opening || $("app").getAttribute("src")) return;
  opening = true;
  appReady = false;
  const path = (await ask("takeOpenPath", { windowId: await panelWindow() }).catch(() => null))?.path;
  $("app").src = path ? `${APP_PAGE}?at=${encodeURIComponent(path)}` : APP_PAGE;
  opening = false;
}

/** A conversation the extension started (a quick question on the page): shown in the loaded app. */
async function showOpenPath() {
  if (!$("app").getAttribute("src")) return openApp();
  if (!appReady) return;
  const opened = await ask("takeOpenPath", { windowId: await panelWindow() });
  if (opened) postToApp({ type: "open", path: opened.path, ...(opened.channel ? { channel: opened.channel } : {}) });
}

function closeApp() {
  appReady = false;
  $("app").removeAttribute("src");
}

async function deliverPassages() {
  if (!appReady) return;
  for (const passage of await ask("takePassages")) postToApp({ type: "passage", ...passage });
}

window.addEventListener("message", async (event) => {
  // Only the app's own frame, from its own origin, in this protocol.
  if (event.origin !== APP_ORIGIN || event.source !== appWindow()) return;
  const data = event.data;
  if (!data || data.protocol !== PROTOCOL) return;
  if (data.type === "session-request" && typeof data.id === "string") {
    const session = await ask("session", { renew: data.renew === true }).catch(() => null);
    postToApp(session
      ? { type: "session", id: data.id, token: session.token, ...(session.user ? { user: session.user } : {}) }
      : { type: "signed-out", id: data.id });
    if (!session) await render();
  } else if (data.type === "space" && data.space && typeof data.space === "object") {
    await ask("rememberSpace", { space: data.space }).catch(() => undefined);
  } else if (data.type === "account") {
    await ask("rememberAccount", { user: data.user }).catch(() => undefined);
  } else if (data.type === "upgrade-required") {
    // The Hub no longer takes this build of the app: only a newer extension has a newer one.
    updateRequired = true;
    await render();
  } else if (data.type === "ready") {
    appReady = true;
    await deliverPassages();
    await showOpenPath();
    await showRecent();
    await showPage();
  } else if (data.type === "page-thread" && typeof data.path === "string") {
    const tab = await activeTab();
    if (tab?.id !== undefined) await ask("rememberPageThread", { tabId: tab.id, path: data.path, title: data.title, href: data.href });
  } else if (data.type === "open-tab" && typeof data.href === "string" && capturableUrl(data.href)) {
    await chrome.tabs.create({ url: data.href });
  } else if (data.type === "browser-read" && typeof data.requestId === "string") {
    await answerBrowserRead(data).catch(() => undefined);
  } else if (data.type === "browser-read-approval" && typeof data.requestId === "string") {
    approvals.get(data.requestId)?.(data.allow === true);
  } else if (data.type === "signed-out") {
    await ask("signOut");
    await render();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.passages?.newValue?.length) deliverPassages().catch(() => undefined);
  if (area === "session" && changes.openPath?.newValue && !$("view-app").hidden) showOpenPath().catch(() => undefined);
  if (area === "local" && changes.recentThreads) showRecent().catch(() => undefined);
  // A question asked on the page gave it a conversation: the bar knows it now.
  if (area === "session" && Object.keys(changes).some((key) => key.startsWith("askThread:"))) showPage().catch(() => undefined);
  if ((area === "local" && changes.session) || (area === "session" && changes.signIn)) render().catch(() => undefined);
});

// ---- The page beside the panel. The panel is its companion: the conversation started from it, or one about it.

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/** A page as a place to talk about: its address without the fragment (background.js pageKey). */
function pageKey(href) {
  const url = new URL(href);
  url.hash = "";
  return url.toString();
}

/** The conversation the tab's questions about its page went to, as the service worker keeps it. */
async function pageThread(tab, href) {
  const key = `askThread:${tab.id}`;
  const { [key]: thread } = await chrome.storage.session.get(key);
  return thread && thread.page === pageKey(href) ? thread : null;
}

/**
 * Tells the app the page beside the panel. A page with a conversation of its
 * own brings it into view; a page without one leaves the open conversation
 * where it is, and the app offers to ask about this page (Daniel 2026-11-23).
 */
let shownPage = "";
async function showPage() {
  if (!appReady) return;
  const tab = await activeTab();
  const href = capturableUrl(tab?.url ?? "");
  if (!tab || !href) return;
  const thread = await pageThread(tab, href);
  const path = thread ? `/app/${encodeURIComponent(thread.spaceId)}/channels/${encodeURIComponent(thread.channelId)}` : undefined;
  postToApp({ type: "page", title: pageTitle(tab.title) || new URL(href).host, href,
    ...(path ? { path } : {}) });
  const key = `${tab.id} ${pageKey(href)}`;
  if (path && key !== shownPage) postToApp({ type: "open", path, ...(thread.snapshot ? { channel: thread.snapshot } : {}) });
  shownPage = key;
}

/**
 * A tab as an Agent reads it: its accessibility snapshot, as Playwright's `ariaSnapshot()` writes it (the
 * extension's src/page-snapshot.js, built from snapshot/page-snapshot.ts), at most 200,000 characters; empty
 * where it cannot be read.
 */
async function readTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/page-snapshot.js"] });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxChars) => globalThis.__xmatrixPageSnapshot?.(maxChars) ?? "",
      args: [200_000],
    });
    return typeof result?.result === "string" ? result.result : "";
  } catch {
    // A page this extension may not read (no access to it, or the browser's own pages).
    return "";
  }
}

// ---- Agents reading a page through this browser (`xmatrix browse`, packages/hub src/browser-read.ts).
//
// The page beside the panel is read at once: the person is chatting about it there. So is the page the
// conversation was started from, if a tab still shows it. Another tab is read only once the person allows it,
// in the app's dialog; a page that is not open is not opened.

/** The open tab showing `page` (a pageKey), the active one first. */
async function openTabShowing(page) {
  const tabs = await chrome.tabs.query({});
  const showing = tabs.filter((tab) => {
    const href = capturableUrl(tab.url ?? "");
    return href && pageKey(href) === page;
  });
  return showing.find((tab) => tab.active) ?? showing[0] ?? null;
}

/** The page a conversation was started from: a tab still asking in it, or where Recent says it began. */
async function conversationPage(channelId) {
  const stored = await chrome.storage.session.get(null);
  for (const [key, thread] of Object.entries(stored)) {
    if (!key.startsWith("askThread:") || thread?.channelId !== channelId) continue;
    const tab = await chrome.tabs.get(Number(key.slice("askThread:".length))).catch(() => null);
    const href = capturableUrl(tab?.url ?? "");
    if (tab && href && pageKey(href) === thread.page) return { page: thread.page, tab };
    return { page: thread.page, tab: await openTabShowing(thread.page) };
  }
  const { recentThreads = [] } = await chrome.storage.local.get("recentThreads");
  const recent = recentThreads.find((item) => String(item.path).endsWith(`/channels/${encodeURIComponent(channelId)}`));
  const href = recent && capturableUrl(String(recent.href ?? ""));
  return href ? { page: pageKey(href), tab: await openTabShowing(pageKey(href)) } : null;
}

/** The person's choice in the app's dialog, by request: allow, or not (unanswered counts as not). */
const approvals = new Map();
function approve(requestId, agentName, tab, href) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(false), 85_000);
    const settle = (allow) => {
      clearTimeout(timer);
      approvals.delete(requestId);
      resolve(allow);
    };
    approvals.set(requestId, settle);
    postToApp({ type: "browser-read-approve", requestId, agentName,
      title: pageTitle(tab.title) || new URL(href).host, href });
  });
}

async function readForAgent({ channelId, target, agentName, requestId }) {
  // The page beside this panel: the person shows it by chatting here (Daniel 2026-11-23: no prompt for it).
  if (target === "current") {
    const [tab] = await chrome.tabs.query({ active: true, windowId: await panelWindow() }).catch(() => []);
    const href = capturableUrl(tab?.url ?? "");
    if (!tab?.id || !href) return { refusal: "no-page" };
    const text = await readTab(tab.id);
    return text ? { title: pageTitle(tab.title) || "", href, text } : { refusal: "unreadable" };
  }
  if (target === "conversation") {
    const found = await conversationPage(String(channelId ?? ""));
    if (!found) return { refusal: "no-page" };
    if (!found.tab?.id) return { refusal: "not-open" };
    const text = await readTab(found.tab.id);
    return text ? { title: pageTitle(found.tab.title) || "", href: capturableUrl(found.tab.url), text } : { refusal: "unreadable" };
  }
  const href = capturableUrl(String(target ?? ""));
  const tab = href ? await openTabShowing(pageKey(href)) : null;
  // Without access to web pages the extension cannot see other tabs' addresses at all.
  if (!tab?.id) return { refusal: await chrome.permissions.contains({ origins: WEB_ORIGINS }) ? "not-open" : "no-access" };
  const tabHref = capturableUrl(tab.url);
  if (!(await approve(requestId, String(agentName || "An Agent"), tab, tabHref))) return { refusal: "denied" };
  const text = await readTab(tab.id);
  return text ? { title: pageTitle(tab.title) || "", href: tabHref, text } : { refusal: "unreadable" };
}

async function answerBrowserRead(request) {
  if (!(await ask("claimBrowserRead", { requestId: request.requestId }))) return;
  let answer;
  try {
    answer = await readForAgent(request);
  } catch {
    answer = { refusal: "unreadable" };
  }
  await ask("browserReadAnswer", { requestId: request.requestId, answer });
}

async function showRecent() {
  if (!appReady) return;
  const { recentThreads = [] } = await chrome.storage.local.get("recentThreads");
  postToApp({ type: "recent", recent: recentThreads.slice(0, 5)
    .map((item) => ({ path: item.path, title: item.title, href: item.href })) });
}

// Asked from this click: Chrome shows its permission prompt only in a user gesture.
$("quick-select-on").addEventListener("click", async () => {
  await chrome.permissions.request({ origins: WEB_ORIGINS }).catch(() => false);
  await ask("quickSelectAsked");
  await render();
});
$("quick-select-skip").addEventListener("click", async () => {
  await ask("quickSelectAsked");
  await render();
});

chrome.tabs.onActivated.addListener(() => showPage().catch(() => undefined));
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.title || change.url)) showPage().catch(() => undefined);
});

// ---- Signing in.

let updateRequired = false;

async function render() {
  if (updateRequired) {
    closeApp();
    show("view-update");
    return;
  }
  const state = await ask("state");
  if (state.signedIn) {
    // Once, right after signing in: the one choice the panel needs, before the app.
    const quickSelect = await ask("quickSelectState");
    if (!quickSelect.granted && !quickSelect.asked) {
      closeApp();
      show("view-quick-select");
      return;
    }
    show("view-app");
    await openApp();
    return;
  }
  closeApp();
  if (state.signIn) {
    show("view-signing-in");
    $("user-code").textContent = state.signIn.userCode ?? "";
    $("sign-in-error").hidden = !state.signIn.error;
    $("sign-in-error").textContent = state.signIn.error ?? "";
    return;
  }
  show("view-signed-out");
}

$("sign-in").addEventListener("click", async () => {
  $("sign-in").disabled = true;
  $("signed-out-error").hidden = true;
  try {
    await ask("signIn");
    await render();
  } catch (error) {
    fail($("signed-out-error"), error);
  } finally {
    $("sign-in").disabled = false;
  }
});

$("cancel-sign-in").addEventListener("click", async () => {
  await ask("cancelSignIn");
  await render();
});

// Chrome fetches a newer version when there is one and restarts the extension onto it.
$("update").addEventListener("click", () => {
  chrome.runtime.requestUpdateCheck(() => chrome.runtime.reload());
});

render().catch((error) => {
  show("view-signed-out");
  fail($("signed-out-error"), error);
});
