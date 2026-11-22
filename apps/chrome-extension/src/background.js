// The service worker owns the extension's session: the side panel's app asks
// it for a current access token and the account (the refresh token never
// leaves here), and it queues what the person picks on a page until the panel
// hands it over.

import {
  HubError,
  accountFrom,
  countNeedsYou,
  createConversation,
  listSpaces,
  sendMessage,
  freshAccessToken,
  hubUrl,
  pollDeviceSignIn,
  signOut,
  startDeviceSignIn,
  tokenExpiresAt,
  withSession,
} from "./hub-client.js";
import { discussionTitle, pagePassage } from "./passage.js";

const BADGE_ALARM = "needs-you";
const SIGN_IN_ALARM = "sign-in";
const MENU_ASK = "ask";
const MENU_PAGE = "ask-page";
const SELECTION_SCRIPT = "selection-chip";
const WEB_ORIGINS = ["https://*/*", "http://*/*"];

const manifest = chrome.runtime.getManifest();
const deps = { fetch: (...args) => fetch(...args), hubUrl: hubUrl(manifest), version: manifest.version };

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
 * The Space a quick question goes to: the one the side panel's app shows (it
 * announces it, and the panel remembers it here), or the person's first when
 * the panel never opened. A Space that is gone is looked up again.
 */
async function quickAskSpace(token, { fresh = false } = {}) {
  const { lastSpace } = await chrome.storage.local.get("lastSpace");
  if (lastSpace?.id && !fresh) return lastSpace;
  const spaces = await listSpaces(deps, token);
  return spaces.find((space) => space.id === lastSpace?.id) ?? spaces[0] ?? null;
}

/**
 * What the question box on a tab was opened on: the passage picked there (or
 * the page itself) and the tab's window, kept until the box sends or another
 * passage is picked. Only this extension's content script in that tab, or its
 * context menu, sets it; the box reads it by the tab it is framed in.
 */
async function setPendingAsk(tab, text) {
  const passage = pagePassage({ text, title: tab.title, url: tab.url, target: "new" });
  if (!passage || tab.id === undefined) return;
  await chrome.storage.session.set({ [`ask:${tab.id}`]: {
    text: passage.text, label: passage.label || new URL(passage.href).host, href: passage.href, windowId: tab.windowId ?? null } });
}

async function pendingAsk(tabId) {
  const key = `ask:${tabId}`;
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) throw new Error("Select some text on the page first.");
  return pending;
}

/** The box's session and target, as the side panel's app gets its own: a current access token, never the refresh token. */
async function askContext(tab) {
  const passage = await pendingAsk(tab.id);
  const session = await panelHandlers.session({});
  if (!session?.user) throw new Error("Sign in to xMatrix in the side panel first.");
  const { lastSpace } = await chrome.storage.local.get("lastSpace");
  return { token: session.token, user: session.user, spaceId: lastSpace?.id ?? null,
    passage: { text: passage.text, label: passage.label, href: passage.href }, windowId: passage.windowId };
}

/**
 * Starts the conversation the box asked for, without waiting for the app: the
 * panel then shows it. The box is the App's composer and wrote the message
 * as it does there (the quoted passage, the question, the Agents picked in
 * it); a message that names nobody lets the Space's routing pick the Agent.
 */
async function askSend(tab, { body, invocationSelections }) {
  const passage = await pendingAsk(tab.id);
  const text = typeof body === "string" ? body.slice(0, 64 * 1024) : "";
  if (!text.trim()) throw new Error("Write a question first.");
  const session = await store.get();
  if (!session) throw new Error("Sign in to xMatrix in the side panel first.");
  const result = await authed(async (scoped, token) => {
    const create = (space) => createConversation(scoped, token, {
      spaceId: space.id, name: discussionTitle(passage.text || passage.label), memberName: session.user?.name || "Human" });
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
    // Picks were made against the remembered Space; in another one they do not apply.
    const picks = space.id === (await chrome.storage.local.get("lastSpace")).lastSpace?.id ? invocationSelections : undefined;
    await sendMessage(scoped, token, { channelId: channel.id, body: text, clientMessageId: crypto.randomUUID(),
      ...(picks && typeof picks === "object" ? { invocationSelections: picks } : {}) });
    return { space, channel };
  });
  await chrome.storage.session.remove(`ask:${tab.id}`);
  await chrome.storage.local.set({ lastSpace: { id: result.space.id, name: result.space.name } });
  // The panel shows it: at once if its app is loaded, or opening straight onto it.
  await chrome.storage.session.set({ openPath: {
    path: `/app/${encodeURIComponent(result.space.id)}/channels/${encodeURIComponent(result.channel.id)}`, at: Date.now() } });
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
  /** The app's session: a current access token and the account, never the refresh token. */
  async session({ renew = false }) {
    // The usual case answers from storage at once; only a renewal takes the queue.
    let session = await store.get();
    if (!session) return null;
    // The app asks for a renewal when the account changed under the token (its name is a claim of the token).
    if (renew || tokenExpiresAt(session.token) - Date.now() <= 10 * 60 * 1000) {
      if (!(await serial(() => freshAccessToken(deps, store, renew ? Infinity : undefined)))) return null;
      session = await store.get();
    }
    return session ? { token: session.token, user: session.user ?? null } : null;
  },
  /** The account as the app just read it from the Hub: what the panel opens with next time. */
  rememberAccount({ user }) {
    const account = accountFrom(user);
    // In the renewal's queue: a write here must not put back a token a renewal just replaced.
    return serial(async () => {
      const session = await store.get();
      // Only the session's own account: the app cannot make this session someone else's.
      if (!session || !account || (session.user?.id && session.user.id !== account.id)) return;
      await store.set({ ...session, user: account });
    });
  },
  takePassages,
  /** The Space the side panel's app shows: where questions asked on a page go. */
  async rememberSpace({ space }) {
    const id = typeof space?.id === "string" ? space.id.slice(0, 128) : "";
    const name = typeof space?.name === "string" ? space.name.slice(0, 300) : "";
    if (id) await chrome.storage.local.set({ lastSpace: { id, name } });
  },
  /** Whether the person turned the button beside selections on, or said not now, after signing in. */
  async quickSelectState() {
    const { quickSelectAsked = false } = await chrome.storage.local.get("quickSelectAsked");
    return { granted: await chrome.permissions.contains({ origins: WEB_ORIGINS }), asked: quickSelectAsked };
  },
  async quickSelectAsked() {
    await chrome.storage.local.set({ quickSelectAsked: true });
  },
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
  const answer = (work) => {
    work.then((value) => reply({ ok: true, value }))
      .catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  };
  // The selection script runs in web pages: it may only hand over a passage of its own tab.
  if (message?.type === "askPrepare" && sender.tab && !isExtensionPage(sender)) {
    return answer(setPendingAsk(sender.tab, String(message.text ?? "")));
  }
  // The question box is this extension's page, framed in that tab: it reads and sends that tab's ask only.
  if (isExtensionPage(sender) && sender.tab?.id !== undefined) {
    if (message?.type === "askContext") return answer(askContext(sender.tab));
    if (message?.type === "askSend") return answer(askSend(sender.tab, message.args ?? {}));
  }
  const handler = isExtensionPage(sender) ? panelHandlers[message?.type] : undefined;
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message.args ?? {}))
    .then((value) => reply({ ok: true, value }))
    .catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

// ---- Context menu: "Ask about…" opens the question box right on the page.

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ASK, title: "Ask about “%s”", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Ask about this page", contexts: ["page"] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if ((info.menuItemId !== MENU_ASK && info.menuItemId !== MENU_PAGE) || tab?.id === undefined) return;
  // The menu's click lets this extension into this one tab (activeTab) to open the box there.
  try {
    await setPendingAsk({ ...tab, url: info.pageUrl ?? tab.url }, info.menuItemId === MENU_ASK ? info.selectionText ?? "" : "");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/selection.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "open-ask", page: info.menuItemId === MENU_PAGE, text: info.selectionText ?? "" });
  } catch {
    // A page no extension may enter (the Web Store, a PDF): the panel starts the conversation instead.
    openPanel(tab);
    queuePassage(pagePassage({ text: info.selectionText ?? "", title: tab.title, url: info.pageUrl ?? tab.url, target: "new" }));
  }
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
