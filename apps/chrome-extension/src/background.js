// The service worker owns the session: every Hub call runs here, so the popup,
// the context menu and the badge never renew the same token twice at once.

import {
  DEFAULT_HUB_URL,
  HubError,
  countNeedsYou,
  listChannels,
  listSpaces,
  pollDeviceSignIn,
  sendMessage,
  signOut,
  startDeviceSignIn,
  withSession,
} from "./hub-client.js";
import { capturableUrl } from "./compose.js";

const BADGE_ALARM = "needs-you";
const SIGN_IN_ALARM = "sign-in";
const MENU_PAGE = "send-page";
const MENU_SELECTION = "send-selection";
const MENU_LINK = "send-link";

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
function authed(call) {
  const run = inFlight.then(() => withSession(deps, store, call));
  inFlight = run.catch(() => undefined);
  return run;
}

async function setBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
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

// ---- Sign-in: the person approves in a tab, so the popup may close meanwhile.

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

// ---- Popup requests.

const handlers = {
  async state() {
    const session = await store.get();
    const { signIn, capture } = await chrome.storage.session.get(["signIn", "capture"]);
    return { user: session?.user ?? null, signedIn: Boolean(session), signIn: signIn ?? null, capture: capture ?? null };
  },
  signIn: beginSignIn,
  async cancelSignIn() {
    await chrome.storage.session.remove("signIn");
    await chrome.alarms.clear(SIGN_IN_ALARM);
  },
  signOut: endSession,
  spaces: () => authed((scoped, token) => listSpaces(scoped, token)),
  channels: ({ spaceId }) => authed((scoped, token) => listChannels(scoped, token, spaceId)),
  async send({ channelId, body, clientMessageId }) {
    const sent = await authed((scoped, token) => sendMessage(scoped, token, { channelId, body, clientMessageId }));
    await chrome.storage.session.remove("capture");
    refreshBadge();
    return sent;
  },
  async lastTarget() {
    const { lastTarget } = await chrome.storage.local.get("lastTarget");
    return lastTarget ?? null;
  },
  async rememberTarget({ spaceId, channelId }) {
    await chrome.storage.local.set({ lastTarget: { spaceId, channelId } });
  },
  async clearCapture() {
    await chrome.storage.session.remove("capture");
  },
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only the extension's own pages (the popup, or its fallback window) may ask.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message.args ?? {}))
    .then((value) => reply({ ok: true, value }))
    .catch((error) => reply({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof HubError ? error.code : undefined,
    }));
  return true;
});

// ---- Context menu: capture what was clicked, then open the popup to choose where it goes.

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Send page to xMatrix", contexts: ["page"] });
    chrome.contextMenus.create({ id: MENU_SELECTION, title: "Send selection to xMatrix", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_LINK, title: "Send link to xMatrix", contexts: ["link"] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const capture = info.menuItemId === MENU_LINK
    ? { url: capturableUrl(info.linkUrl ?? ""), title: info.selectionText ?? "", selection: "" }
    : {
      url: capturableUrl(info.pageUrl ?? tab?.url ?? ""),
      title: tab?.title ?? "",
      selection: info.menuItemId === MENU_SELECTION ? info.selectionText ?? "" : "",
    };
  if (!capture.url) return;
  await chrome.storage.session.set({ capture });
  try {
    await chrome.action.openPopup();
  } catch {
    // Chrome versions without openPopup from a menu: open the same page in a small window.
    await chrome.windows.create({ url: chrome.runtime.getURL("src/popup.html"), type: "popup", width: 400, height: 600 });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM) refreshBadge();
  if (alarm.name === SIGN_IN_ALARM) pollSignIn();
});

chrome.runtime.onInstalled.addListener(() => {
  installMenus();
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  refreshBadge();
});
