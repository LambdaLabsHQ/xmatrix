// The service worker owns the extension's session: the side panel's app asks
// it for a current access token (the refresh token never leaves here), and it
// queues what the person picks on a page until the panel hands it over.

import {
  DEFAULT_HUB_URL,
  HubError,
  countNeedsYou,
  createConversation,
  listSpaces,
  sendMessage,
  freshAccessToken,
  pollDeviceSignIn,
  signOut,
  startDeviceSignIn,
  tokenExpiresAt,
  withSession,
} from "./hub-client.js";
import { discussionHead, discussionTitle, pagePassage } from "./passage.js";

const BADGE_ALARM = "needs-you";
const SIGN_IN_ALARM = "sign-in";
const MENU_NEW = "discuss-new";
const MENU_QUOTE = "quote-current";
const SELECTION_SCRIPT = "selection-chip";
const WEB_ORIGINS = ["https://*/*", "http://*/*"];

const manifest = chrome.runtime.getManifest();
const deps = { fetch: (...args) => fetch(...args), hubUrl: DEFAULT_HUB_URL, version: manifest.version };

let pendingWrite = Promise.resolve();
const store = {
  async get() {
    const { session } = await chrome.storage.local.get("session");
    return session ?? null;
  },
  set(session) {
    pendingWrite = pendingWrite.then(() => (session
      ? chrome.storage.local.set({ session })
      : chrome.storage.local.remove("session")));
    return pendingWrite;
  },
};

// One renewal at a time: a second caller waits for the first one's token.
let inFlight = Promise.resolve();
function serial(call) {
  const run = inFlight.then(call);
  inFlight = run.catch(() => undefined);
  return run;
}
// Calls with a valid token run at once: the badge's catalog read must not hold up the panel or a question.
const authed = (call) => withSession(deps, store, call);

async function setBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: "#b5832f" });
  await chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? "99+" : String(count)) : "" });
}

async function refreshBadge() {
  if (!(await store.get())) return setBadge(0);
  try {
    await setBadge(await authed((scoped, token) => countNeedsYou(scoped, token)));
  } catch (error) {
    if (error instanceof HubError && error.code === "signed_out") await setBadge(0);
  }
}

// ---- Sign-in: the person approves in a tab, so the panel may lose focus meanwhile.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let polling = false;

/** Asks the Hub until the sign-in is approved, declined or expired; one loop at a time. */
async function pollSignIn() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const { signIn } = await chrome.storage.session.get("signIn");
      if (!signIn || signIn.error) return;
      if (Date.now() > signIn.expiresAt) {
        await failSignIn(signIn, "The sign-in request expired. Start again.");
        return;
      }
      let wait = 5_000;
      try {
        const answer = await pollDeviceSignIn(deps, signIn.deviceCode);
        if (answer.session) {
          await store.set(answer.session);
          await chrome.storage.session.remove("signIn");
          await chrome.alarms.clear(SIGN_IN_ALARM);
          await refreshBadge();
          return;
        }
        wait = answer.intervalMs;
      } catch (error) {
        if (error instanceof HubError && error.status === 429) wait = 10_000;
        else if (error instanceof HubError && error.status >= 400 && error.status < 500) {
          await failSignIn(signIn, error.message);
          return;
        }
      }
      await sleep(wait);
    }
  } finally {
    polling = false;
  }
}

async function failSignIn(signIn, error) {
  await chrome.storage.session.set({ signIn: { ...signIn, error } });
  await chrome.alarms.clear(SIGN_IN_ALARM);
}

async function beginSignIn() {
  const started = await startDeviceSignIn(deps);
  await chrome.storage.session.set({
    signIn: { deviceCode: started.deviceCode, userCode: started.userCode, expiresAt: started.expiresAt },
  });
  // The worker may be stopped while the person approves; the alarm wakes it to keep asking.
  await chrome.alarms.create(SIGN_IN_ALARM, { periodInMinutes: 0.5 });
  await chrome.tabs.create({ url: started.verificationUri });
  pollSignIn();
  return { userCode: started.userCode };
}

async function endSession() {
  const session = await store.get();
  await store.set(null);
  await setBadge(0);
  if (session) await signOut(deps, session).catch(() => undefined);
}

// ---- Passages: picked on a page, waiting for the panel's app to take them.

async function queuePassage(passage) {
  if (!passage) return;
  const { passages = [] } = await chrome.storage.session.get("passages");
  await chrome.storage.session.set({ passages: [...passages.slice(-4), passage] });
}

async function takePassages() {
  const { passages = [] } = await chrome.storage.session.get("passages");
  await chrome.storage.session.remove("passages");
  return passages;
}

/** Opens the panel beside the tab. Called first in a click handler: Chrome allows it only in a user gesture. */
function openPanel(tab) {
  if (tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
}

// ---- Quick ask: a question about a passage, started straight through the Hub.

/**
 * The Space a quick question goes to: the one last used, or the person's
 * first. Remembered, so a question costs no Space lookup once one was asked;
 * a Space that is gone is looked up again.
 */
async function quickAskSpace(token, { fresh = false } = {}) {
  const { lastSpace } = await chrome.storage.local.get("lastSpace");
  if (lastSpace?.id && !fresh) return lastSpace;
  const spaces = await listSpaces(deps, token);
  return spaces.find((space) => space.id === lastSpace?.id) ?? spaces[0] ?? null;
}

/**
 * Starts a conversation holding the passage and the question, without waiting
 * for the app: the panel then shows it. Mentioning an Agent hands it the work
 * at once.
 */
async function quickAsk(tab, { text, question }) {
  const passage = pagePassage({ text, title: tab.title, url: tab.url, target: "new" });
  const asked = String(question ?? "").trim().slice(0, 8000);
  if (!passage || !passage.text || !asked) throw new Error("Select some text and write a question.");
  const session = await store.get();
  if (!session) throw new Error("Sign in to xMatrix in the side panel first.");
  const result = await authed(async (scoped, token) => {
    const create = (space) => createConversation(scoped, token, {
      spaceId: space.id, name: discussionTitle(passage.text), memberName: session.user?.name || "Human" });
    let space = await quickAskSpace(token);
    if (!space) throw new Error("You are not in any Space yet.");
    let channel;
    try {
      channel = await create(space);
    } catch (error) {
      // The remembered Space may be gone or no longer ours: look the Spaces up once and retry.
      if (!(error instanceof HubError) || ![403, 404].includes(error.status)) throw error;
      space = await quickAskSpace(token, { fresh: true });
      if (!space) throw new Error("You are not in any Space yet.");
      channel = await create(space);
    }
    await sendMessage(scoped, token, { channelId: channel.id,
      body: discussionHead(passage.text, { label: passage.label || new URL(passage.href).host, href: passage.href }) + asked,
      clientMessageId: crypto.randomUUID() });
    return { space, channel };
  });
  await chrome.storage.local.set({ lastSpace: { id: result.space.id, name: result.space.name } });
  // The panel shows it: at once if its app is loaded, or opening straight onto it.
  await chrome.storage.session.set({ openPath: {
    path: `/app/${encodeURIComponent(result.space.id)}/${encodeURIComponent(result.channel.id)}`, at: Date.now() } });
  return { spaceName: result.space.name };
}

// ---- Quick select: a small button beside selected text, on pages the person allowed.

async function syncSelectionScript() {
  const granted = await chrome.permissions.contains({ origins: WEB_ORIGINS });
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SELECTION_SCRIPT] });
  if (granted && registered.length === 0) {
    await chrome.scripting.registerContentScripts([{
      id: SELECTION_SCRIPT, matches: WEB_ORIGINS, js: ["src/selection.js"], runAt: "document_idle",
    }]);
  } else if (!granted && registered.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [SELECTION_SCRIPT] });
  }
}

// ---- Requests from the side panel (extension pages only) and the selection button (content script).

const panelHandlers = {
  async state() {
    const session = await store.get();
    const { signIn } = await chrome.storage.session.get("signIn");
    return { signedIn: Boolean(session), signIn: signIn ?? null };
  },
  signIn: beginSignIn,
  async cancelSignIn() {
    await chrome.storage.session.remove("signIn");
    await chrome.alarms.clear(SIGN_IN_ALARM);
  },
  signOut: endSession,
  async token() {
    // The usual case answers from storage at once; only a renewal takes the queue.
    const session = await store.get();
    if (session && tokenExpiresAt(session.token) - Date.now() > 10 * 60 * 1000) return session.token;
    return serial(() => freshAccessToken(deps, store));
  },
  takePassages,
  async takeOpenPath() {
    const { openPath } = await chrome.storage.session.get("openPath");
    await chrome.storage.session.remove("openPath");
    return openPath && Date.now() - openPath.at < 60_000 ? openPath.path : null;
  },
  queuePassage: ({ passage }) => queuePassage(pagePassage(passage ?? {})),
  quickSelect: () => chrome.permissions.contains({ origins: WEB_ORIGINS }),
};

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  // The selection button runs in web pages: it may only hand over a passage of its own tab.
  if (message?.type === "quick-ask" && sender.tab) {
    openPanel(sender.tab);
    quickAsk(sender.tab, message)
      .then((value) => reply({ ok: true, value }))
      .catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "chip" && sender.tab) {
    openPanel(sender.tab);
    queuePassage(pagePassage({ text: message.text, title: sender.tab.title, url: sender.tab.url, target: message.target }));
    return false;
  }
  const handler = isExtensionPage(sender) ? panelHandlers[message?.type] : undefined;
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message.args ?? {}))
    .then((value) => reply({ ok: true, value }))
    .catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

// ---- Context menu: what was clicked goes to the panel, quoted or as a new conversation.

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_NEW, title: "Discuss in xMatrix", contexts: ["selection", "page", "link"] });
    chrome.contextMenus.create({ id: MENU_QUOTE, title: "Quote in the open xMatrix conversation", contexts: ["selection"] });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  openPanel(tab);
  const target = info.menuItemId === MENU_QUOTE ? "current" : "new";
  const passage = info.linkUrl && !info.selectionText
    ? pagePassage({ text: "", title: info.linkUrl, url: info.linkUrl, target })
    : pagePassage({ text: info.selectionText ?? "", title: tab?.title, url: info.pageUrl ?? tab?.url, target });
  queuePassage(passage);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) refreshBadge();
  if (alarm.name === SIGN_IN_ALARM) pollSignIn();
});

chrome.permissions.onAdded.addListener(() => syncSelectionScript());
chrome.permissions.onRemoved.addListener(() => syncSelectionScript());

function start() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  syncSelectionScript().catch(() => undefined);
  refreshBadge();
}

chrome.runtime.onInstalled.addListener(() => {
  installMenus();
  start();
});
chrome.runtime.onStartup.addListener(start);
