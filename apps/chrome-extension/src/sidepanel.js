// The side panel: the xMatrix app in a frame, signed in with the extension's
// session, with a bar for the page beside it.
//
// The app is packaged with the extension (app/, built from apps/web by
// scripts/build-app.mjs), so opening the panel loads nothing from the Web. It
// asks for its session over postMessage (apps/web src/lib/extension-embed.ts);
// this page answers only its own frame at the extension's origin, and posts
// only to that origin. Passages picked on a page (the context menu, the
// selection button, this bar) are handed to the app once it says it is ready.

import { capturableUrl, pagePassage, pageTitle } from "./passage.js";

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
  } else if (data.type === "signed-out") {
    await ask("signOut");
    await render();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.passages?.newValue?.length) deliverPassages().catch(() => undefined);
  if (area === "session" && changes.openPath?.newValue && !$("view-app").hidden) showOpenPath().catch(() => undefined);
  if ((area === "local" && changes.session) || (area === "session" && changes.signIn)) render().catch(() => undefined);
});

// ---- The page beside the panel.

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

async function renderContext() {
  const tab = await activeTab();
  const url = capturableUrl(tab?.url ?? "");
  $("context").hidden = !url;
  if (url) {
    $("context-title").textContent = pageTitle(tab.title) || new URL(url).host;
    $("context-title").title = url;
  }
}

/** The page's selected text, where this extension may read the page; empty otherwise. */
async function selectionIn(tab) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(globalThis.getSelection?.() ?? ""),
    });
    return typeof result?.result === "string" ? result.result : "";
  } catch {
    return "";
  }
}

async function sendPage(target) {
  const tab = await activeTab();
  if (!tab) return;
  const passage = pagePassage({ text: await selectionIn(tab), title: tab.title, url: tab.url, target });
  if (!passage) return;
  if (appReady) postToApp({ type: "passage", ...passage });
  else await ask("queuePassage", { passage });
}

$("context-ask").addEventListener("click", () => sendPage("new"));

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

chrome.tabs.onActivated.addListener(() => renderContext().catch(() => undefined));
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.title || change.url || change.status === "complete")) renderContext().catch(() => undefined);
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
    await renderContext();
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
