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
import { pageKey, readTabSnapshot, tabPageThread } from "./page-tab.js";
import { isPlayConsoleUrl } from "./play-reports-bucket.js";

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

/**
 * The tab this panel belongs to (Daniel 2026-11-24: one panel per page, each its own thread): background.js opens
 * it as `sidepanel.html?tab=<id>`. It shows that tab's page and conversation, whichever tab is in front.
 */
const PANEL_TAB = Number(new URLSearchParams(location.search).get("tab")) || null;

// Tell background.js while this tab's side panel is open so the page's selection script knows
// whether to show the inline thread/edge dock or switch to a lightweight quote-to-side-panel pill.
if (PANEL_TAB) {
  const connectPanelPort = () => {
    try {
      const port = chrome.runtime.connect({ name: `sidepanel:${PANEL_TAB}` });
      port.onMessage.addListener((message) => {
        if (message?.type === "approve-browser-read" && typeof message.requestId === "string") {
          void answerTabApprovalRead(message).catch(() => undefined);
        }
      });
      port.onDisconnect.addListener(() => {
        // Reconnect if the service worker restarted while this panel stayed open.
        if (document.visibilityState !== "hidden") setTimeout(connectPanelPort, 500);
      });
    } catch {
      // Extension context invalidated during reload.
    }
  };
  connectPanelPort();
}

/** A question still on its way to the conversation the app opened at, for the app to show as sending. */
let pendingOnOpen = null;

let panelDisplayedNotified = false;
function notifyPanelDisplayed() {
  if (panelDisplayedNotified || !PANEL_TAB) return;
  panelDisplayedNotified = true;
  void ask("panelReady", { tabId: PANEL_TAB }).catch(() => undefined);
}

/** Loads the app, straight onto a conversation the extension just started when there is one. */
let opening = false;
async function openApp() {
  if (opening || $("app").getAttribute("src")) return;
  opening = true;
  appReady = false;
  panelDisplayedNotified = false;
  const [opened, existing] = await Promise.all([
    ask("takeOpenPath", { tabId: PANEL_TAB }).catch(() => null),
    PANEL_TAB ? tabPageThread(chrome, PANEL_TAB).catch(() => null) : Promise.resolve(null),
  ]);
  let path = opened?.path;
  if (!path && existing) {
    path = `/app/${encodeURIComponent(existing.spaceId)}/channels/${encodeURIComponent(existing.channelId)}`;
  }
  // Remember the initial path already loaded via `?at=` so `showPage()` does not re-open it.
  if (path) shownPath = path;
  // The app opens at the conversation; the question on its way is shown there once the app is ready.
  pendingOnOpen = opened?.pending ? opened : null;
  $("app").src = path ? `${APP_PAGE}?at=${encodeURIComponent(path)}` : APP_PAGE;
  opening = false;
}

/** A conversation the extension started (a quick question on the page): shown in the loaded app. */
async function showOpenPath() {
  if (!$("app").getAttribute("src")) return openApp();
  if (!appReady) return;
  const opened = await ask("takeOpenPath", { tabId: PANEL_TAB });
  if (opened) postToApp({ type: "open", path: opened.path, ...(opened.channel ? { channel: opened.channel } : {}),
    ...(opened.pending ? { pending: opened.pending } : {}) });
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
    await refreshPlayBucket().catch(() => undefined);
  } else if (data.type === "account") {
    await ask("rememberAccount", { user: data.user }).catch(() => undefined);
  } else if (data.type === "upgrade-required") {
    // The Hub no longer takes this build of the app: only a newer extension has a newer one.
    updateRequired = true;
    await render();
  } else if (data.type === "ready") {
    appReady = true;
    if (pendingOnOpen) {
      shownPath = pendingOnOpen.path;
      postToApp({ type: "open", path: pendingOnOpen.path, ...(pendingOnOpen.channel ? { channel: pendingOnOpen.channel } : {}),
        pending: pendingOnOpen.pending });
      pendingOnOpen = null;
    }
    await deliverPassages();
    await showOpenPath();
    await showRecent();
    await showPage();
    if (!shownPath) notifyPanelDisplayed();
  } else if (data.type === "channel-displayed") {
    notifyPanelDisplayed();
  } else if (data.type === "outbox-register" && data.entry && typeof data.entry === "object") {
    void ask("outboxRegister", {
      ...data.entry,
      ...(PANEL_TAB ? { tabId: PANEL_TAB } : {}),
      source: "sidepanel",
    }).catch(() => undefined);
  } else if (data.type === "outbox-ack" && typeof data.clientMessageId === "string") {
    void ask("outboxAck", { clientMessageId: data.clientMessageId }).catch(() => undefined);
  } else if (data.type === "page-thread" && typeof data.path === "string") {
    const tab = await activeTab();
    if (tab?.id !== undefined) {
      shownPath = data.path;
      await ask("rememberPageThread", {
        tabId: tab.id,
        path: data.path,
        title: data.title,
        href: data.href,
        recordRecent: data.recordRecent !== false,
      });
    }
  } else if (data.type === "clear-page-thread") {
    const tab = await activeTab();
    shownPath = "";
    if (tab?.id !== undefined) await ask("clearPageThread", { tabId: tab.id });
  } else if (data.type === "open-tab" && typeof data.href === "string" && capturableUrl(data.href)) {
    await chrome.tabs.create({ url: data.href });
  } else if (data.type === "show-page" && typeof data.href === "string" && capturableUrl(data.href)) {
    const preferredTabId = PANEL_TAB ?? (await activeTab())?.id ?? null;
    await ask("showPage", { href: data.href, preferredTabId }).catch(() => undefined);
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
  if (area === "session" && changes[`openPath:${PANEL_TAB}`]?.newValue && !$("view-app").hidden) showOpenPath().catch(() => undefined);
  if (area === "local" && changes.recentThreads) showRecent().catch(() => undefined);
  if (area === "local" && changes.outboxFailures) refreshOutboxFailures().catch(() => undefined);
  // A question asked on the page gave this tab a conversation: the bar knows it now.
  if (area === "local" && changes[`askThread:${PANEL_TAB}`]) showPage().catch(() => undefined);
  if (area === "session" && changes[`playBucketHint:${PANEL_TAB}`]?.newValue) {
    dismissedPlayPage = "";
    refreshPlayBucket({ force: true }).catch(() => undefined);
  }
  if ((area === "local" && changes.session) || (area === "session" && changes.signIn)) render().catch(() => undefined);
});

// ---- The page beside the panel. The panel is its companion: the conversation started from it, or one about it.

/** This panel's tab (named activeTab for what it was: the panel once followed whichever tab was in front). */
async function activeTab() {
  if (PANEL_TAB) return chrome.tabs.get(PANEL_TAB).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/** The conversation bound to this tab (one tab = one thread). */
const pageThread = (tab) => tabPageThread(chrome, tab.id);

/**
 * Tells the app the page beside the panel and opens this tab's bound conversation
 * when it changes. Changing URL inside the same tab updates the page metadata
 * without breaking the tab's active thread.
 */
let shownPath = "";
async function showPage() {
  if (!appReady) return;
  const tab = await activeTab();
  const href = capturableUrl(tab?.url ?? "");
  if (!tab || !href) return;
  const thread = await pageThread(tab);
  const path = thread ? `/app/${encodeURIComponent(thread.spaceId)}/channels/${encodeURIComponent(thread.channelId)}` : undefined;
  postToApp({ type: "page", title: pageTitle(tab.title) || new URL(href).host, href,
    ...(path ? { path } : {}) });
  if (path && path !== shownPath) {
    postToApp({ type: "open", path, ...(thread.snapshot ? { channel: thread.snapshot } : {}) });
    shownPath = path;
  }
  await refreshPlayBucket().catch(() => undefined);
}

// ---- Undelivered background outbox notices (when a send could not reach the Hub after leaving a page).

let outboxFailureList = [];

function renderOutboxFailureBar() {
  const bar = $("outbox-failure-bar");
  if (!bar || $("view-app").hidden || outboxFailureList.length === 0) {
    if (bar) bar.hidden = true;
    return;
  }
  const latest = outboxFailureList[outboxFailureList.length - 1];
  const count = outboxFailureList.length;
  $("outbox-failure-title").textContent = count === 1
    ? "A question could not be sent"
    : `${count} questions could not be sent`;
  $("outbox-failure-detail").textContent = latest?.preview || latest?.title || latest?.error || "Try asking again.";
  bar.hidden = false;
}

async function refreshOutboxFailures() {
  if ($("view-app").hidden) {
    const bar = $("outbox-failure-bar");
    if (bar) bar.hidden = true;
    return;
  }
  const list = await ask("outboxFailures").catch(() => []);
  outboxFailureList = Array.isArray(list) ? list : [];
  renderOutboxFailureBar();
}

$("outbox-failure-dismiss")?.addEventListener("click", async () => {
  outboxFailureList = [];
  renderOutboxFailureBar();
  await ask("dismissOutboxFailures").catch(() => undefined);
});

// ---- Google Play Console bulk reports bucket one-click sync (plain pubsite_prod_rev_* ID only, never cookies).

let playState = null;
let dismissedPlayPage = "";
let syncingPlayBucket = false;

function renderPlayBucketBar() {
  const bar = $("play-bucket-bar");
  if (!playState?.isPlayConsole || $("view-app").hidden) {
    bar.hidden = true;
    return;
  }
  const key = pageKey(playState.url || "");
  if (dismissedPlayPage && dismissedPlayPage === key && !playState.synced) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const title = $("play-bucket-title");
  const detail = $("play-bucket-detail");
  const select = $("play-bucket-select");
  const action = $("play-bucket-action");
  const secondary = $("play-bucket-secondary");
  const error = $("play-bucket-error");

  error.hidden = !playState.error;
  error.textContent = playState.error ?? "";
  select.hidden = true;
  secondary.hidden = true;
  detail.classList.remove("mono");

  const spaceName = playState.space?.name || "current Space";
  const buckets = Array.isArray(playState.buckets) ? playState.buckets : [];

  if (playState.synced?.bucket) {
    title.textContent = "Google Play reports bucket synced";
    detail.textContent = `${playState.synced.bucket} → ${playState.synced.spaceName || spaceName} (@googleplay)`;
    detail.classList.add("mono");
    action.hidden = true;
    return;
  }

  action.hidden = false;
  if (buckets.length > 0) {
    if (buckets.length > 1) {
      select.hidden = false;
      const previous = select.value;
      select.replaceChildren(...buckets.map((bucket) => {
        const option = document.createElement("option");
        option.value = bucket;
        option.textContent = bucket;
        return option;
      }));
      if (buckets.includes(previous)) select.value = previous;
    }
    const chosen = buckets.length > 1 ? select.value : buckets[0];
    const alreadySaved = playState.savedBucket === chosen;
    title.textContent = alreadySaved ? "Google Play reports bucket synced" : "Google Play reports bucket found";
    detail.textContent = alreadySaved ? `${chosen} · saved in ${spaceName}` : chosen;
    detail.classList.add("mono");
    action.textContent = syncingPlayBucket ? "Syncing…" : alreadySaved ? "Re-sync" : `Sync to ${spaceName}`;
    action.disabled = syncingPlayBucket;
    return;
  }

  title.textContent = "Google Play bulk reports";
  detail.textContent = playState.onDownloadReports
    ? "No pubsite_prod_rev_… URI visible yet. Open a report tab, then check again."
    : "Open Download reports to detect and sync your pubsite_prod_rev_… bucket.";
  action.textContent = "Detect bucket";
  action.disabled = syncingPlayBucket;
  if (!playState.onDownloadReports && playState.downloadReportsUrl) {
    secondary.hidden = false;
    secondary.textContent = "Download reports";
    secondary.disabled = syncingPlayBucket;
  }
}

async function refreshPlayBucket({ force = false } = {}) {
  if ($("view-app").hidden) {
    $("play-bucket-bar").hidden = true;
    return;
  }
  const tab = await activeTab();
  if (!tab?.id || (!force && !isPlayConsoleUrl(tab.url ?? ""))) {
    playState = null;
    renderPlayBucketBar();
    return;
  }
  const next = await ask("inspectPlayBucket", { tabId: tab.id }).catch(() => ({ isPlayConsole: false }));
  if (playState?.synced && next.isPlayConsole && next.savedBucket === playState.synced.bucket && !next.synced) {
    next.synced = playState.synced;
  }
  playState = next;
  renderPlayBucketBar();
}

$("play-bucket-select").addEventListener("change", () => renderPlayBucketBar());

$("play-bucket-dismiss").addEventListener("click", () => {
  dismissedPlayPage = pageKey(playState?.url || "");
  if (playState) playState = { ...playState, synced: null };
  renderPlayBucketBar();
});

$("play-bucket-secondary").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab?.id !== undefined && playState?.downloadReportsUrl) {
    await chrome.tabs.update(tab.id, { url: playState.downloadReportsUrl }).catch(() => undefined);
  }
});

$("play-bucket-action").addEventListener("click", async () => {
  if (!playState?.isPlayConsole || syncingPlayBucket) return;
  const buckets = Array.isArray(playState.buckets) ? playState.buckets : [];
  if (buckets.length === 0) {
    await refreshPlayBucket({ force: true });
    return;
  }
  const bucket = buckets.length > 1 ? $("play-bucket-select").value : buckets[0];
  const tab = await activeTab();
  syncingPlayBucket = true;
  playState = { ...playState, error: null };
  renderPlayBucketBar();
  try {
    const synced = await ask("syncPlayBucket", {
      bucket,
      spaceId: playState.space?.id,
      tabId: tab?.id,
    });
    playState = { ...playState, savedBucket: synced.bucket, synced, error: null };
  } catch (caught) {
    playState = { ...playState, error: caught instanceof Error ? caught.message : String(caught) };
  } finally {
    syncingPlayBucket = false;
    renderPlayBucketBar();
  }
});

const readTab = (tabId) => readTabSnapshot(chrome, tabId);

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

/** Handles cross-tab `--tab <url>` read approval forwarded directly from the Service Worker. */
async function answerTabApprovalRead({ requestId, target, agentName }) {
  let answer;
  try {
    const href = capturableUrl(String(target ?? ""));
    const tab = href ? await openTabShowing(pageKey(href)) : null;
    // Without access to web pages the extension cannot see other tabs' addresses at all.
    if (!tab?.id) {
      answer = { refusal: await chrome.permissions.contains({ origins: WEB_ORIGINS }) ? "not-open" : "no-access" };
    } else {
      const tabHref = capturableUrl(tab.url);
      if (!(await approve(requestId, String(agentName || "An Agent"), tab, tabHref))) {
        answer = { refusal: "denied" };
      } else {
        const text = await readTab(tab.id);
        answer = text ? { title: pageTitle(tab.title) || "", href: tabHref, text } : { refusal: "unreadable" };
      }
    }
  } catch {
    answer = { refusal: "unreadable" };
  }
  await ask("browserReadAnswer", { requestId, answer });
}

/** Forwards all `xmatrix browse` reads to the single Service Worker arbiter (no racing across panels/cards). */
async function answerBrowserRead(request) {
  await ask("resolveBrowserRead", {
    requestId: request.requestId,
    target: String(request.target ?? "current"),
    channelId: typeof request.channelId === "string" ? request.channelId : "",
    agentName: typeof request.agentName === "string" ? request.agentName : "",
    panelTabId: PANEL_TAB,
  });
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

// The panel follows its own tab to each page it shows; another tab in front changes nothing here.
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if ((PANEL_TAB ? id === PANEL_TAB : tab.active) && (change.title || change.url || change.status === "complete")) {
    showPage().catch(() => undefined);
  }
});
if (!PANEL_TAB) chrome.tabs.onActivated.addListener(() => showPage().catch(() => undefined));

// ---- Signing in.

let updateRequired = false;

async function render() {
  if (updateRequired) {
    closeApp();
    show("view-update");
    return;
  }
  const [state, quickSelect] = await Promise.all([
    ask("state"),
    ask("quickSelectState").catch(() => ({ granted: true, asked: true })),
  ]);
  if (state.signedIn) {
    // Once, right after signing in: the one choice the panel needs, before the app.
    if (!quickSelect.granted && !quickSelect.asked) {
      closeApp();
      show("view-quick-select");
      return;
    }
    show("view-app");
    await openApp();
    await Promise.all([
      refreshOutboxFailures().catch(() => undefined),
      refreshPlayBucket({ force: true }).catch(() => undefined),
    ]);
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
