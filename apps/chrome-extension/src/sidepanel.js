// The side panel: the xMatrix web app in a frame, signed in with the
// extension's session, with a bar for the page beside it.
//
// The app asks for an access token over postMessage (apps/web
// src/lib/extension-embed.ts); this page answers only the app's own origin and
// frame, and posts only to that origin. Passages picked on a page (the context
// menu, the selection button, this bar) are handed to the app once it says it
// is ready.

import { appOrigin } from "./hub-client.js";
import { capturableUrl, pagePassage } from "./passage.js";

const PROTOCOL = "xmatrix-embed/1";
const APP_ORIGIN = appOrigin(chrome.runtime.getManifest());
const WEB_ORIGINS = ["https://*/*", "http://*/*"];
const $ = (id) => document.getElementById(id);
const views = ["view-signed-out", "view-signing-in", "view-app"];

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

/** Loads the app, straight onto a conversation the extension just started when there is one. */
let opening = false;
async function openApp() {
  if (opening || $("app").getAttribute("src")) return;
  opening = true;
  appReady = false;
  const path = await ask("takeOpenPath").catch(() => null);
  $("app").src = `${APP_ORIGIN}${path ?? "/app"}`;
  opening = false;
}

/** A conversation the extension started (a quick question on the page): shown in the loaded app. */
async function showOpenPath() {
  if (!$("app").getAttribute("src")) return openApp();
  if (!appReady) return;
  const path = await ask("takeOpenPath");
  if (path) postToApp({ type: "open", path });
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
    const token = await ask("token").catch(() => null);
    postToApp(token ? { type: "session", id: data.id, token } : { type: "signed-out", id: data.id });
    if (!token) await render();
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
    $("context-title").textContent = tab.title || new URL(url).host;
    $("context-title").title = url;
  }
  $("quick-select").hidden = await chrome.permissions.contains({ origins: WEB_ORIGINS });
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

$("context-quote").addEventListener("click", () => sendPage("current"));
$("context-new").addEventListener("click", () => sendPage("new"));

// Asked from this click: Chrome shows its permission prompt only in a user gesture.
$("quick-select-on").addEventListener("click", async () => {
  await chrome.permissions.request({ origins: WEB_ORIGINS }).catch(() => false);
  await renderContext();
});

chrome.tabs.onActivated.addListener(() => renderContext().catch(() => undefined));
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.title || change.url || change.status === "complete")) renderContext().catch(() => undefined);
});

// ---- Signing in.

async function render() {
  const state = await ask("state");
  if (state.signedIn) {
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

render().catch((error) => {
  show("view-signed-out");
  fail($("signed-out-error"), error);
});
