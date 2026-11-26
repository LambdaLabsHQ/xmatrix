// The service worker owns the extension's session: the side panel's app asks
// it for a current access token and the account (the refresh token never
// leaves here), and it queues what the person picks on a page until the panel
// hands it over.

import {
  HubError,
  accountFrom,
  answerBrowserRead,
  createConversation,
  listSpaces,
  readConnectorCredentials,
  saveConnectorCredentials,
  sendMessage,
  freshAccessToken,
  hubUrl,
  pollDeviceSignIn,
  signOut,
  startDeviceSignIn,
  tokenExpiresAt,
  withSession,
} from "./hub-client.js";
import { capturableUrl, discussionTitle, pagePassage, pageTitle } from "./passage.js";
import { OUTBOX_ALARM_NAME, createOutbox } from "./outbox.js";
import { clearAllTabThreads, clearTabThread, isTrustedWebAppOrigin, migrateTabThread, pageKey, readTabSnapshot, selectBrowserReadTab, setTabThread, showWebPage, tabPageThread } from "./page-tab.js";
import {
  PLAY_BUCKET_PATTERN,
  findOpenPlayConsoleBuckets,
  isPlayConsoleUrl,
  isPlayDownloadReportsUrl,
  playDownloadReportsUrl,
  readPlayBucketsFromTab,
} from "./play-reports-bucket.js";

const SIGN_IN_ALARM = "sign-in";
const MENU_ASK = "ask";
const MENU_PAGE = "ask-page";
const MENU_PLAY_BUCKET = "sync-play-bucket";
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
// Calls with a valid token run at once; only a renewal takes the queue.
const authed = (call) => withSession(deps, store, call);

// The toolbar shows no badge (Daniel 2026-11-23: a standing count of everything waiting was noise); the panel's
// "Needs you" lists what waits. A badge an earlier version set is cleared at start.

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
  await outbox.clearAll().catch(() => undefined);
  await store.set(null);
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
/**
 * One side panel per tab (Daniel 2026-11-24: the panel belongs to its page; each tab is its own thread). A tab's
 * panel shows that tab's page and conversation; switching to a tab without one hides the panel, and switching back
 * brings that tab's own back. The panel is turned on for a tab when it is first opened there.
 */
function enablePanel(tabId) {
  return chrome.sidePanel.setOptions({ tabId, path: `src/sidepanel.html?tab=${tabId}`, enabled: true });
}

/** Tabs whose side panel page currently holds an open port to this service worker (`tabId -> Port`). */
const openPanels = new Map();
/** Safety fallback timers to release hidden inline Apps if a panel opens without displaying a channel. */
const panelReleaseTimers = new Map();
/** In-memory index of tabs known to have a bound thread so `tabs.onUpdated` avoids storage reads for unbound tabs. */
let boundThreadTabs = null;

function clearPanelReleaseTimer(tabId) {
  const timer = panelReleaseTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    panelReleaseTimers.delete(tabId);
  }
}

function releaseTabInlineApp(tabId) {
  clearPanelReleaseTimer(tabId);
  if (!Number.isInteger(tabId)) return;
  void chrome.tabs.sendMessage(tabId, { type: "panel-release" }).catch(() => undefined);
}

async function ensureBoundThreadTabs() {
  if (boundThreadTabs) return boundThreadTabs;
  const stored = await chrome.storage.local.get(null).catch(() => ({}));
  const ids = new Set();
  for (const [key, thread] of Object.entries(stored ?? {})) {
    if (!key.startsWith("askThread:") || !thread?.channelId || !thread?.spaceId) continue;
    const id = Number(key.slice("askThread:".length));
    if (Number.isInteger(id)) ids.add(id);
  }
  boundThreadTabs = ids;
  return ids;
}

async function notifyTabPanelState(tabId, open) {
  if (!Number.isInteger(tabId)) return;
  const thread = await tabPageThread(chrome, tabId);
  if (!open && thread) await enablePanel(tabId).catch(() => undefined);
  await chrome.tabs.sendMessage(tabId, {
    type: "panel-state",
    open,
    hasThread: Boolean(thread),
    ...(thread ? { thread: { spaceId: thread.spaceId, channelId: thread.channelId } } : {}),
  }).catch(() => undefined);
}

chrome.runtime.onConnect.addListener((port) => {
  const match = /^sidepanel:(\d+)$/u.exec(port.name);
  if (!match) return;
  const tabId = Number(match[1]);
  openPanels.set(tabId, port);
  notifyTabPanelState(tabId, true).catch(() => undefined);
  clearPanelReleaseTimer(tabId);
  panelReleaseTimers.set(tabId, setTimeout(() => {
    panelReleaseTimers.delete(tabId);
    if (openPanels.has(tabId)) releaseTabInlineApp(tabId);
  }, 10_000));
  port.onDisconnect.addListener(() => {
    if (openPanels.get(tabId) === port) {
      openPanels.delete(tabId);
      clearPanelReleaseTimer(tabId);
      notifyTabPanelState(tabId, false).catch(() => undefined);
    }
  });
});

/** Opens a tab's own panel. Not awaited between the two: Chrome opens a panel only within the person's gesture. */
function openPanel(tab) {
  if (tab?.id === undefined) return;
  enablePanel(tab.id).catch(() => undefined);
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
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
async function setPendingAsk(tab, text, page = {}) {
  // Chrome names a tab's address and title only where this extension may read the tab; the page's own script knows them.
  const passage = pagePassage({ text, title: tab.title ?? page.title, url: tab.url ?? page.url, target: "new" });
  if (!passage || tab.id === undefined) throw new Error("xMatrix can only ask about web pages.");
  await chrome.storage.session.set({ [`ask:${tab.id}`]: {
    text: passage.text, label: passage.label || new URL(passage.href).host, href: passage.href } });
  // The box opens this tab's panel when it sends: it has to be turned on for the tab before then.
  await enablePanel(tab.id).catch(() => undefined);
}

async function pendingAsk(tabId) {
  const key = `ask:${tabId}`;
  const { [key]: pending } = await chrome.storage.session.get(key);
  if (!pending) throw new Error("Select some text on the page first.");
  return pending;
}

/** The box's session and target, as the side panel's app gets its own: a current access token, never the refresh token. */
async function askContext(tab, { optionalPassage = false } = {}) {
  const passage = optionalPassage
    ? await pendingAsk(tab.id).catch(() => {
      const href = capturableUrl(tab.url ?? "");
      return href ? { text: "", label: tab.title || new URL(href).host, href } : null;
    })
    : await pendingAsk(tab.id);
  // The box shows at once with the stored session; a renewal, when one is due, follows (the box asks for "session").
  const stored = await store.get();
  const session = stored ? { token: stored.token, user: stored.user ?? null } : null;
  if (!session?.user) throw Object.assign(new Error("Sign in to xMatrix in the side panel first."), { code: "signed_out" });
  const { lastSpace } = await chrome.storage.local.get("lastSpace");
  const [thread, outboxFailures] = await Promise.all([
    tabPageThread(chrome, tab.id),
    outbox.listFailures().catch(() => []),
  ]);
  if (thread) await enablePanel(tab.id).catch(() => undefined);
  return {
    token: session.token,
    user: session.user,
    spaceId: thread?.spaceId ?? lastSpace?.id ?? null,
    passage: passage ? { text: passage.text, label: passage.label, href: passage.href } : null,
    thread: thread ? {
      spaceId: thread.spaceId,
      channelId: thread.channelId,
      title: thread.title ?? passage?.label ?? "",
      snapshot: thread.snapshot ?? null,
    } : null,
    outboxFailures,
    panelOpen: openPanels.has(tab.id),
    tabId: tab.id,
  };
}

async function readSnapshotAnswer(targetTab) {
  const href = capturableUrl(targetTab?.url ?? "");
  if (!targetTab?.id || !href) return { refusal: "no-page" };
  const text = await readTabSnapshot(chrome, targetTab.id);
  return text ? { title: targetTab.title || "", href, text } : { refusal: "unreadable" };
}

/** Picks an open side panel port to show a cross-tab `--tab <url>` approval dialog. */
async function pickApprovalPanelPort(preferredTabId = null) {
  if (openPanels.size === 0) return null;
  const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (front?.id !== undefined && openPanels.has(front.id)) return openPanels.get(front.id);
  if (Number.isInteger(preferredTabId) && openPanels.has(preferredTabId)) return openPanels.get(preferredTabId);
  return openPanels.values().next().value ?? null;
}

/**
 * Single Service Worker arbiter for `xmatrix browse` across BOTH side panels and inline cards:
 * claims each `requestId` at most once and ALWAYS answers immediately (never silent, never 250ms race).
 * - `current` / `conversation`: reads only via `selectBrowserReadTab` (bound tab or foreground tab with open panel).
 * - `--tab <url>`: forwards directly to an open side panel port for approval, or refuses `panel-closed`.
 */
async function resolveBrowserRead({ requestId, target, channelId, agentName, panelTabId } = {}) {
  if (typeof requestId !== "string" || !requestId || !panelHandlers.claimBrowserRead({ requestId })) return;
  if (target !== "current" && target !== "conversation") {
    const port = await pickApprovalPanelPort(panelTabId);
    if (port) {
      try {
        port.postMessage({
          type: "approve-browser-read",
          requestId,
          target: String(target ?? ""),
          channelId: typeof channelId === "string" ? channelId : "",
          agentName: typeof agentName === "string" ? agentName : "",
        });
        return;
      } catch {
        // Port disconnected right before post; fall through to refuse immediately.
      }
    }
    await panelHandlers.browserReadAnswer({ requestId, answer: { refusal: "panel-closed" } });
    return;
  }
  let answer;
  try {
    const selected = await selectBrowserReadTab(chrome, {
      channelId: typeof channelId === "string" ? channelId : "",
      openPanelTabIds: openPanels,
    });
    if (selected.refusal || !selected.tab) {
      answer = { refusal: selected.refusal ?? "no-page" };
    } else {
      answer = await readSnapshotAnswer(selected.tab);
    }
  } catch {
    answer = { refusal: "unreadable" };
  }
  await panelHandlers.browserReadAnswer({ requestId, answer });
}

async function askBrowserRead(_tab, args) {
  return resolveBrowserRead(args);
}

/** Prepares this tab's side panel to open straight onto the inline conversation (called on ◫, edge dock, or approval handoff click). */
async function askDock(tab, { spaceId, channelId, messageId } = {}) {
  const existing = await tabPageThread(chrome, tab.id);
  const resolvedSpaceId = typeof spaceId === "string" && spaceId ? spaceId : existing?.spaceId;
  const resolvedChannelId = typeof channelId === "string" && channelId ? channelId : existing?.channelId;
  const cleanMessageId = typeof messageId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(messageId)
    ? messageId
    : "";
  await enablePanel(tab.id).catch(() => undefined);
  if (resolvedSpaceId && resolvedChannelId) {
    const hash = cleanMessageId ? `#message:${cleanMessageId}` : "";
    await chrome.storage.session.set({
      [`openPath:${tab.id}`]: {
        channel: existing?.snapshot ?? null,
        path: `/app/${encodeURIComponent(resolvedSpaceId)}/channels/${encodeURIComponent(resolvedChannelId)}${hash}`,
        at: Date.now(),
      },
    });
  }
  return { ok: true };
}

/**
 * Starts the conversation the box asked for, without waiting for the app: the
 * panel then shows it. The box is the App's composer and wrote the message
 * as it does there (the quoted passage, the question, the Agents picked in
 * it); a message that names nobody lets the Space's routing pick the Agent.
 */
/** The conversations started from the extension, newest first: the panel's Recent. */
async function rememberRecent({ spaceId, channelId, title, href }) {
  const path = `/app/${encodeURIComponent(spaceId)}/channels/${encodeURIComponent(channelId)}`;
  const { recentThreads = [] } = await chrome.storage.local.get("recentThreads");
  await chrome.storage.local.set({ recentThreads: [{ path, title: String(title ?? "").slice(0, 300), href, at: Date.now() },
    ...recentThreads.filter((item) => item.path !== path)].slice(0, 5) });
}

/**
 * The conversation a tab's questions go to (one tab = one conversation thread):
 * switching pages inside the same tab continues the tab's thread while updating
 * each message's browserPage metadata; switching Space or clicking "+" starts fresh.
 */
async function askThread(tab, spaceId) {
  const thread = await tabPageThread(chrome, tab.id);
  return thread && thread.spaceId === spaceId ? thread : null;
}

async function askSend(tab, { body, invocationSelections, channelId: explicitChannelId, spaceId: explicitSpaceId, page: explicitPage }) {
  const passage = await pendingAsk(tab.id).catch(() => {
    const href = capturableUrl(explicitPage?.href ?? tab.url ?? "");
    if (!href) throw new Error("Select some text on the page first.");
    return { text: "", label: explicitPage?.label || tab.title || new URL(href).host, href };
  });
  const text = typeof body === "string" ? body.slice(0, 64 * 1024) : "";
  if (!text.trim()) throw new Error("Write a question first.");
  const session = await store.get();
  if (!session) throw new Error("Sign in to xMatrix in the side panel first.");
  const clientMessageId = crypto.randomUUID();
  const metadata = { browserPage: { title: passage.label, href: passage.href } };
  const threadTitle = discussionTitle(passage.text || passage.label);
  const show = async (space, channel) => {
    await setTabThread(chrome, tab.id, { page: pageKey(passage.href), spaceId: space.id,
      channelId: channel.id, title: channel.snapshot?.name || threadTitle, snapshot: channel.snapshot ?? null });
    boundThreadTabs?.add(tab.id);
    await chrome.storage.local.set({ lastSpace: { id: space.id, name: space.name } });
    await chrome.storage.session.set({ [`openPath:${tab.id}`]: { channel: channel.snapshot ?? null,
      path: `/app/${encodeURIComponent(space.id)}/channels/${encodeURIComponent(channel.id)}`, at: Date.now(),
      pending: { clientMessageId, body: text, metadata } } });
    void rememberRecent({ spaceId: space.id, channelId: channel.id, title: passage.label, href: passage.href });
  };
  const result = await authed(async (scoped, token) => {
    const create = (space) => createConversation(scoped, token, {
      spaceId: space.id, name: threadTitle, memberName: session.user?.name || "Human" });
    let space = await quickAskSpace(token);
    if (!space) throw new Error("You are not in any Space yet.");
    const remembered = (await chrome.storage.local.get("lastSpace")).lastSpace?.id;
    const message = (channelId, inSpace) => sendMessage(scoped, token, { channelId, body: text, clientMessageId,
      metadata,
      ...(inSpace === remembered && invocationSelections && typeof invocationSelections === "object"
        ? { invocationSelections } : {}) });
    if (typeof explicitChannelId === "string" && explicitChannelId) {
      const targetSpace = typeof explicitSpaceId === "string" && explicitSpaceId ? { id: explicitSpaceId, name: space.name } : space;
      const channel = { id: explicitChannelId, snapshot: null };
      await show(targetSpace, channel);
      await message(explicitChannelId, targetSpace.id);
      return { space: targetSpace, channel };
    }
    const thread = await askThread(tab, space.id);
    if (thread) {
      const channel = { id: thread.channelId, snapshot: thread.snapshot ?? null };
      await show(space, channel);
      try {
        await message(thread.channelId, space.id);
        return { space, channel };
      } catch (error) {
        // The conversation is gone or no longer ours: this question starts a new one.
        if (!(error instanceof HubError) || ![403, 404].includes(error.status)) throw error;
      }
    }
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
    await show(space, channel);
    // A failure here leaves the conversation open and the page's questions going to it: asking again lands there.
    await message(channel.id, space.id);
    return { space, channel };
  });
  await chrome.storage.session.remove(`ask:${tab.id}`);
  return {
    spaceName: result.space.name,
    spaceId: result.space.id,
    channelId: result.channel.id,
    title: result.channel.snapshot?.name || threadTitle,
    snapshot: result.channel.snapshot ?? null,
    clientMessageId,
  };
}

// ---- Durable outbox: ensures inline-card and side-panel sends reach the Hub even if the page closes or navigates.

async function deliverOutboxEntry(entry, { onChannelCreated }) {
  const session = await store.get();
  if (!session) throw Object.assign(new Error("Sign in to xMatrix first."), { code: "signed_out" });
  if (entry.userId && session.user?.id && entry.userId !== session.user.id) {
    throw new HubError(403, "Outbox entry belongs to another account.", "account_mismatch");
  }
  let resolvedChannelId = entry.channelId ?? null;
  let resolvedSpaceId = entry.spaceId ?? entry.channelCreate?.spaceId ?? null;
  let createdSnapshot = null;
  await authed(async (scoped, token) => {
    if (entry.channelCreate && !entry.channelCreated) {
      if (!resolvedSpaceId) {
        const space = await quickAskSpace(token);
        if (!space) throw new HubError(404, "You are not in any Space yet.");
        resolvedSpaceId = space.id;
      }
      const createName = entry.channelCreate.name
        || discussionTitle(entry.channelCreate.body || entry.body);
      const created = await createConversation(scoped, token, {
        spaceId: resolvedSpaceId,
        name: createName,
        mode: entry.channelCreate.mode,
        memberName: entry.channelCreate.memberName || session.user?.name || "Human",
        metadata: entry.channelCreate.metadata,
        requestKey: entry.channelCreate.requestKey,
      });
      resolvedChannelId = created.id;
      resolvedSpaceId = created.spaceId || resolvedSpaceId;
      createdSnapshot = created.snapshot ?? null;
      await onChannelCreated({ channelId: resolvedChannelId, spaceId: resolvedSpaceId });
    }
    if (!resolvedChannelId) throw new HubError(400, "Missing conversation ID for outbox send.");
    await sendMessage(scoped, token, {
      channelId: resolvedChannelId,
      body: entry.body,
      clientMessageId: entry.clientMessageId,
      invocationSelections: entry.invocationSelections,
      metadata: entry.metadata,
      replyToMessageId: entry.replyToMessageId,
      appMentions: entry.appMentions,
    });
  });
  if (resolvedSpaceId && resolvedChannelId) {
    const page = entry.metadata?.browserPage;
    const href = capturableUrl(String(entry.href || page?.href || ""));
    const title = String(createdSnapshot?.name || entry.title || page?.title || "").slice(0, 300);
    if (href) {
      void rememberRecent({ spaceId: resolvedSpaceId, channelId: resolvedChannelId, title: title || href, href })
        .catch(() => undefined);
    }
    if (Number.isInteger(entry.tabId)) {
      const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
      if (tab) {
        const existing = await tabPageThread(chrome, entry.tabId).catch(() => null);
        if (!existing) {
          await setTabThread(chrome, entry.tabId, {
            page: href ? pageKey(href) : "",
            spaceId: resolvedSpaceId,
            channelId: resolvedChannelId,
            title,
            snapshot: createdSnapshot,
          }).catch(() => undefined);
          boundThreadTabs?.add(entry.tabId);
        }
      }
    }
  }
}

const outbox = createOutbox({
  storage: chrome.storage.local,
  alarms: chrome.alarms,
  deliver: deliverOutboxEntry,
});

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

/** Agents' page-read requests a side panel took on (panelHandlers.claimBrowserRead). */
const browserReadClaims = new Set();

async function syncPlayBucketForSpace({ bucket, spaceId } = {}) {
  const clean = typeof bucket === "string" ? bucket.trim() : "";
  if (!PLAY_BUCKET_PATTERN.test(clean)) {
    throw new Error("Expected a Play Console Cloud Storage bucket ID (pubsite_prod_rev_…).");
  }
  return authed(async (scoped, token) => {
    let target = null;
    if (typeof spaceId === "string" && spaceId) {
      const { lastSpace } = await chrome.storage.local.get("lastSpace");
      if (lastSpace?.id === spaceId) {
        target = lastSpace;
      } else {
        const spaces = await listSpaces(scoped, token);
        target = spaces.find((space) => space.id === spaceId) ?? { id: spaceId, name: spaceId };
      }
    } else {
      target = await quickAskSpace(token);
    }
    if (!target) throw new Error("You are not in any Space yet.");
    await saveConnectorCredentials(scoped, token, {
      spaceId: target.id,
      providerId: "googleplay",
      providerName: "Google Play Console",
      fields: { reportsBucket: clean },
    });
    return { bucket: clean, spaceId: target.id, spaceName: target.name };
  });
}

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
  /** The panel's app started or switched to a conversation for this tab: all surfaces in this tab follow it. */
  async rememberPageThread({ tabId, path, title, href, recordRecent = true }) {
    const match = typeof path === "string" && path.match(/^\/app\/([A-Za-z0-9_-]{1,128})\/channels\/([A-Za-z0-9_-]{1,128})$/u);
    if (!match || !Number.isInteger(tabId)) return;
    const page = capturableUrl(String(href ?? ""));
    await setTabThread(chrome, tabId, {
      page: page ? pageKey(page) : "",
      spaceId: match[1],
      channelId: match[2],
      title: String(title ?? "").slice(0, 300),
      snapshot: null,
    });
    boundThreadTabs?.add(tabId);
    if (page && recordRecent !== false) await rememberRecent({ spaceId: match[1], channelId: match[2], title, href: page });
    await notifyTabPanelState(tabId, openPanels.has(tabId)).catch(() => undefined);
  },
  /** The person clicked "+" New conversation in this tab's side panel: unbind the previous thread. */
  async clearPageThread({ tabId }) {
    if (!Number.isInteger(tabId)) return;
    await clearTabThread(chrome, tabId);
    boundThreadTabs?.delete(tabId);
    await notifyTabPanelState(tabId, openPanels.has(tabId)).catch(() => undefined);
  },
  /**
   * An Agent's request to read a page reaches every open side panel: the first to claim it answers, so the person
   * is asked once. Claims are kept for the length of an Agent's wait.
   */
  claimBrowserRead({ requestId }) {
    if (typeof requestId !== "string" || !requestId || browserReadClaims.has(requestId)) return false;
    browserReadClaims.add(requestId);
    setTimeout(() => browserReadClaims.delete(requestId), 120_000);
    return true;
  },
  resolveBrowserRead,
  /** The page's text, or why it was not read, back to the Agent waiting for it (packages/hub browser-read.ts). */
  browserReadAnswer({ requestId, answer }) {
    if (typeof requestId !== "string" || !answer || typeof answer !== "object") throw new Error("Invalid answer");
    const body = typeof answer.refusal === "string"
      ? { refusal: answer.refusal.slice(0, 500) }
      : { title: String(answer.title ?? "").slice(0, 300), href: String(answer.href ?? ""),
        text: String(answer.text ?? "").slice(0, 200_000) };
    return authed((scoped, token) => answerBrowserRead(scoped, token, requestId, body));
  },
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
  /** The side panel has painted its conversation: safe to release any hidden inline App in this tab. */
  panelReady({ tabId }) {
    if (Number.isInteger(tabId) && openPanels.has(tabId)) releaseTabInlineApp(tabId);
    return { ok: true };
  },
  outboxRegister(args) {
    return outbox.register(args);
  },
  outboxAck({ clientMessageId } = {}) {
    return outbox.ack(clientMessageId);
  },
  outboxFlushTab({ tabId, source } = {}) {
    return outbox.flushForTab(tabId, { source: source ?? null });
  },
  outboxFailures() {
    return outbox.listFailures();
  },
  dismissOutboxFailures() {
    return outbox.clearFailures();
  },
  /** The conversation the extension just started for this tab's panel, once. */
  async takeOpenPath({ tabId }) {
    if (!Number.isInteger(tabId)) return null;
    const key = `openPath:${tabId}`;
    const { [key]: openPath } = await chrome.storage.session.get(key);
    if (!openPath || Date.now() - openPath.at >= 60_000) return null;
    await chrome.storage.session.remove(key);
    return { path: openPath.path, channel: openPath.channel ?? null, pending: openPath.pending ?? null };
  },
  queuePassage: ({ passage }) => queuePassage(pagePassage(passage ?? {})),
  quickSelect: () => chrome.permissions.contains({ origins: WEB_ORIGINS }),
  /** Brings an open tab showing `href` into view (preferredTabId first), opening one only if closed. */
  showPage: ({ href, preferredTabId }) => showWebPage(chrome, href, {
    preferredTabId: Number.isInteger(preferredTabId) ? preferredTabId : null,
  }),
  /** Detects Play Console Cloud Storage bucket IDs (`pubsite_prod_rev_*`) on this tab; never reads cookies. */
  async inspectPlayBucket({ tabId }) {
    if (!Number.isInteger(tabId)) return { isPlayConsole: false };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const hintKey = `playBucketHint:${tabId}`;
    const { [hintKey]: rawHint } = await chrome.storage.session.get(hintKey);
    const hint = rawHint && Date.now() - rawHint.at < 60_000 ? rawHint : null;
    const playUrl = isPlayConsoleUrl(tab?.url ?? "") ? tab.url : (hint && isPlayConsoleUrl(hint.url) ? hint.url : "");
    if (!playUrl) return { isPlayConsole: false };

    const liveBuckets = await readPlayBucketsFromTab(chrome, tabId);
    const buckets = [...new Set([...liveBuckets, ...(Array.isArray(hint?.buckets) ? hint.buckets : [])])]
      .filter((value) => PLAY_BUCKET_PATTERN.test(value));

    let space = null;
    let savedBucket = null;
    let permissionError = null;
    if (await store.get()) {
      try {
        await authed(async (scoped, token) => {
          space = await quickAskSpace(token);
          if (!space) return;
          const view = await readConnectorCredentials(scoped, token, { spaceId: space.id, providerId: "googleplay" });
          const existing = typeof view?.plain?.reportsBucket === "string" ? view.plain.reportsBucket.trim() : "";
          savedBucket = PLAY_BUCKET_PATTERN.test(existing) ? existing : null;
        });
      } catch (error) {
        if (error instanceof HubError && error.status === 403) {
          permissionError = "Only a Space admin can update Google Play Console settings.";
        }
      }
    }
    return {
      isPlayConsole: true,
      url: playUrl,
      onDownloadReports: isPlayDownloadReportsUrl(playUrl),
      downloadReportsUrl: playDownloadReportsUrl(playUrl),
      buckets,
      space,
      savedBucket,
      synced: hint?.synced ?? null,
      error: hint?.error ?? permissionError,
    };
  },
  /** Writes a validated plain Play Console bucket ID into the Space's `@googleplay` `reportsBucket`. */
  async syncPlayBucket({ bucket, spaceId, tabId }) {
    const result = await syncPlayBucketForSpace({ bucket, spaceId });
    if (Number.isInteger(tabId)) await chrome.storage.session.remove(`playBucketHint:${tabId}`).catch(() => undefined);
    return result;
  },
};

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
}

function originOfSender(sender) {
  if (typeof sender?.origin === "string" && sender.origin) return sender.origin;
  try {
    return sender?.url ? new URL(sender.url).origin : "";
  } catch {
    return "";
  }
}

function replyAsync(work, reply, { includeValue = true } = {}) {
  Promise.resolve()
    .then(work)
    .then((value) => reply(includeValue ? { ok: true, value } : { ok: true }))
    .catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error),
      ...(typeof error?.code === "string" ? { code: error.code } : {}) }));
  return true;
}

// The xMatrix Web app (xmatrix.sh / beta.xmatrix.sh) asks the installed extension to bring back
// the tab a conversation's web page is open in, rather than opening a duplicate tab (Daniel 2026-11-24).
// The answer never reveals whether a tab was already open or newly created.
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (!isTrustedWebAppOrigin(originOfSender(sender), { allowLocalhost: Boolean(manifest.key) })) return false;
  if (message?.protocol !== "xmatrix-embed/1") return false;
  if (message.type === "google-play-bucket") {
    return replyAsync(() => findOpenPlayConsoleBuckets(chrome), reply);
  }
  if (message.type !== "show-page") return false;
  const href = capturableUrl(String(message.href ?? ""));
  if (!href) {
    reply({ ok: false, error: "Invalid web page address." });
    return false;
  }
  return replyAsync(() => showWebPage(chrome, href), reply, { includeValue: false });
});

async function tabAskPageState(tabId) {
  const thread = await tabPageThread(chrome, tabId);
  if (thread && !openPanels.has(tabId)) await enablePanel(tabId).catch(() => undefined);
  return { panelOpen: openPanels.has(tabId), hasThread: Boolean(thread) };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  const answer = (work) => replyAsync(() => work, reply);
  // The selection script runs in web pages: it may only hand over a passage of its own tab.
  // The person started selecting: this wakes the worker, and renews the sign-in now if it is due, off the box's path.
  if (message?.type === "askWarm" && sender.tab && !isExtensionPage(sender)) {
    panelHandlers.session({}).catch(() => undefined);
    reply({ ok: true });
    return false;
  }
  if (message?.type === "askPrepare" && sender.tab && !isExtensionPage(sender)) {
    return answer((async () => {
      const url = typeof message.url === "string" ? message.url : sender.tab.url;
      await setPendingAsk(sender.tab, String(message.text ?? ""), {
        title: typeof message.title === "string" ? message.title : undefined,
        url,
      });
      return tabAskPageState(sender.tab.id);
    })());
  }
  if (message?.type === "askPageState" && sender.tab && !isExtensionPage(sender)) {
    return answer(tabAskPageState(sender.tab.id));
  }
  // The question box is this extension's page, framed in that tab: it reads and sends that tab's ask only.
  if (isExtensionPage(sender) && sender.tab?.id !== undefined) {
    if (message?.type === "askTabId") return answer({ tabId: sender.tab.id });
    if (message?.type === "askContext") return answer(askContext(sender.tab, message.args ?? {}));
    if (message?.type === "askSend") return answer(askSend(sender.tab, message.args ?? {}));
    if (message?.type === "askDock") return answer(askDock(sender.tab, message.args ?? {}));
    if (message?.type === "askRememberThread") {
      return answer((async () => {
        await panelHandlers.rememberPageThread({ tabId: sender.tab.id, ...message.args });
        await chrome.storage.session.remove(`ask:${sender.tab.id}`).catch(() => undefined);
      })());
    }
    if (message?.type === "askClearThread") return answer(panelHandlers.clearPageThread({ tabId: sender.tab.id }));
    if (message?.type === "askBrowserRead") return answer(askBrowserRead(sender.tab, message.args ?? {}));
    if (message?.type === "outboxRegister") {
      const args = message.args ?? {};
      return answer(outbox.register({
        ...args,
        tabId: Number.isInteger(args.tabId) ? args.tabId : sender.tab.id,
        source: args.source === "sidepanel" ? "sidepanel" : "inline",
      }));
    }
    if (message?.type === "outboxAck") {
      return answer(outbox.ack(message.args?.clientMessageId));
    }
    if (message?.type === "outboxFlushTab") {
      return answer(outbox.flushForTab(sender.tab.id, { source: message.args?.source ?? "inline" }));
    }
    if (message?.type === "outboxFailures") return answer(outbox.listFailures());
    if (message?.type === "dismissOutboxFailures") return answer(outbox.clearFailures());
    if (message?.type === "askQuoteToPanel") {
      return answer(queuePassage(pagePassage({
        text: String(message.args?.text ?? ""),
        title: typeof message.args?.label === "string" ? message.args.label : sender.tab.title,
        url: typeof message.args?.href === "string" ? message.args.href : sender.tab.url,
        target: "current",
      })));
    }
  }
  const handler = isExtensionPage(sender) ? panelHandlers[message?.type] : undefined;
  if (!handler) return false;
  return replyAsync(() => handler(message.args ?? {}), reply);
});

// ---- Context menu: "Ask about…" opens the question box right on the page.

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ASK, title: "Ask about “%s”", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Ask about this page", contexts: ["page"] });
    chrome.contextMenus.create({
      id: MENU_PLAY_BUCKET,
      title: "Sync Google Play reports bucket to xMatrix",
      contexts: ["page"],
      documentUrlPatterns: ["https://play.google.com/console/*"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (tab?.id === undefined) return;
  if (info.menuItemId === MENU_PLAY_BUCKET) {
    openPanel(tab);
    const url = info.pageUrl ?? tab.url ?? "";
    const buckets = await readPlayBucketsFromTab(chrome, tab.id);
    let synced = null;
    let error = null;
    if (buckets.length === 1 && await store.get()) {
      try {
        synced = await syncPlayBucketForSpace({ bucket: buckets[0] });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }
    await chrome.storage.session.set({
      [`playBucketHint:${tab.id}`]: { url, buckets, synced, error, at: Date.now() },
    });
    return;
  }
  if (info.menuItemId !== MENU_ASK && info.menuItemId !== MENU_PAGE) return;
  // The menu's click lets this extension into this one tab (activeTab) to open the box there.
  try {
    const targetUrl = info.pageUrl ?? tab.url;
    await setPendingAsk({ ...tab, url: targetUrl }, info.menuItemId === MENU_ASK ? info.selectionText ?? "" : "");
    const existingThread = await tabPageThread(chrome, tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/selection.js"] });
    await chrome.tabs.sendMessage(tab.id, {
      type: "open-ask",
      page: info.menuItemId === MENU_PAGE,
      text: info.selectionText ?? "",
      hasThread: Boolean(existingThread),
    });
  } catch {
    // A page no extension may enter (the Web Store, a PDF): the panel starts the conversation instead.
    openPanel(tab);
    queuePassage(pagePassage({ text: info.selectionText ?? "", title: tab.title, url: info.pageUrl ?? tab.url, target: "new" }));
  }
});

// The toolbar button opens the panel of the tab it is clicked on.
chrome.action.onClicked.addListener((tab) => openPanel(tab));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SIGN_IN_ALARM) pollSignIn();
  if (alarm.name === OUTBOX_ALARM_NAME) outbox.flushDue().catch(() => undefined);
});

// A closed tab's passage and conversation go with it; any in-flight sends flush immediately from the outbox.
chrome.tabs.onRemoved.addListener((tabId) => {
  openPanels.delete(tabId);
  clearPanelReleaseTimer(tabId);
  boundThreadTabs?.delete(tabId);
  outbox.flushForTab(tabId, { tabRemoved: true }).catch(() => undefined);
  clearTabThread(chrome, tabId).catch(() => undefined);
  chrome.storage.session.remove([`ask:${tabId}`, `openPath:${tabId}`, `playBucketHint:${tabId}`]).catch(() => undefined);
});

// Keep tab thread bindings intact if Chrome replaces a tab's ID (prerender or Memory Saver discard/restore).
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const existingPort = openPanels.get(removedTabId);
  if (existingPort) {
    openPanels.delete(removedTabId);
    openPanels.set(addedTabId, existingPort);
  }
  if (boundThreadTabs?.delete(removedTabId)) boundThreadTabs.add(addedTabId);
  migrateTabThread(chrome, removedTabId, addedTabId).catch(() => undefined);
});

// Keep an open inline conversation card synced with SPA/URL/title navigation in the same tab (Item 2),
// and flush any in-flight inline sends immediately when a tab starts a cross-document navigation.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "loading") {
    outbox.flushForTab(tabId, { source: "inline" }).catch(() => undefined);
  }
  if (!change.url && !change.title && change.status !== "complete") return;
  const href = capturableUrl(tab?.url ?? "");
  if (!href) return;
  if (boundThreadTabs && !boundThreadTabs.has(tabId)) return;
  void ensureBoundThreadTabs().then((bound) => {
    if (!bound.has(tabId)) return;
    return chrome.tabs.sendMessage(tabId, {
      type: "page-updated",
      title: pageTitle(tab.title) || new URL(href).host,
      href,
    });
  }).catch(() => undefined);
});

chrome.permissions.onAdded.addListener(() => {
  syncSelectionScript().then(reachOpenPages).catch(() => undefined);
});
chrome.permissions.onRemoved.addListener(() => syncSelectionScript());

function start() {
  // No panel for the whole browser: each tab's own, opened from the toolbar button there (chrome.action.onClicked).
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => undefined);
  chrome.alarms.clear("needs-you").catch(() => undefined);
  chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
  syncSelectionScript().catch(() => undefined);
  outbox.recover().catch(() => undefined);
}

/**
 * Pages already open when the extension was installed or updated: their old
 * script (if any) is cut off from the extension, and a registered script
 * reaches only pages loaded after. The current one goes into each of them now.
 */
async function reachOpenPages() {
  if (!(await chrome.permissions.contains({ origins: WEB_ORIGINS }))) return;
  const tabs = await chrome.tabs.query({ url: WEB_ORIGINS });
  await Promise.all(tabs.map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/selection.js"] })
    .catch(() => undefined)));
}

chrome.runtime.onInstalled.addListener(() => {
  installMenus();
  start();
  reachOpenPages().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  start();
  boundThreadTabs = new Set();
  clearAllTabThreads(chrome).catch(() => undefined);
});

// Resume any persisted outbox sends immediately whenever the service worker wakes up.
outbox.recover().catch(() => undefined);
