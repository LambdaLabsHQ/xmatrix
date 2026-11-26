"use client";

/**
 * The app inside the xMatrix Chrome extension's side panel.
 *
 * The extension ships this app in its own package (src/extension-app,
 * apps/chrome-extension) and shows it in a frame of its side panel page, so
 * opening the panel loads nothing from the Web. The app has no web session
 * there: the extension holds its own (the CLI device sign-in) and hands this
 * frame only a short-lived access token, on request, over `postMessage`. The
 * token stays in memory; the refresh token never leaves the extension's
 * service worker. Every message is checked both ways: this frame answers only
 * a parent whose origin is on EXTENSION_EMBED_ORIGINS and is its own origin,
 * and posts only to that origin. The Web itself allows no page to frame it.
 *
 * The extension also hands over what the person picked on the page they are
 * reading (a passage, or the page itself), to quote in the open conversation
 * or to start a new one with.
 */
import { browserPageMetadata, browserPageOf, CLIENT_COMPATIBILITY_POLICY, clientCompatibilityHeaders, type AgentInvocationSelections, type AuthUser, type SerializedChannel } from "@xmatrix/protocol";
import canonicalVersion from "../../../../version.json" with { type: "json" };
import { EXTENSION_EMBED_ORIGINS, EXTENSION_ID } from "./extension-embed-origins";

const PROTOCOL = "xmatrix-embed/1";
/** The platform this app names itself as when it runs in the extension. */
export const EXTENSION_CLIENT_PLATFORM = "chrome-extension";
const MAX_PASSAGE_CHARS = 20_000;
const MAX_LABEL_CHARS = 300;
const MAX_HREF_CHARS = 2_000;

/** The extension origin this app is packaged in and framed by, or null when it is not in the side panel. */
export function extensionEmbedParent(): string | null {
  if (typeof window === "undefined" || window.parent === window) return null;
  const origin = window.location.ancestorOrigins?.[0];
  return origin && origin === window.location.origin && EXTENSION_EMBED_ORIGINS.includes(origin) ? origin : null;
}

/** Only the framing extension's own messages, in this protocol. */
function fromParent(event: MessageEvent, parent: string): Record<string, unknown> | null {
  if (event.source !== window.parent || event.origin !== parent) return null;
  const data = event.data as unknown;
  if (!data || typeof data !== "object" || (data as { protocol?: unknown }).protocol !== PROTOCOL) return null;
  return data as Record<string, unknown>;
}

function postToParent(parent: string, message: Record<string, unknown>) {
  window.parent.postMessage({ protocol: PROTOCOL, ...message }, parent);
}

/** The extension's session, as it hands it to the app: a current access token, and the account it signed in as. */
export type EmbedSession = {
  token: string;
  /** The account the extension remembers from its sign-in; absent when it kept none. */
  user?: AuthUser;
};

/** The account in a session answer, when it is whole: an id and an email, and bounded text. */
function parseEmbedUser(value: unknown): AuthUser | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, email, name, avatarUrl } = value as Record<string, unknown>;
  const text = (field: unknown, max: number) => (typeof field === "string" && field.length <= max ? field : undefined);
  const userId = text(id, 128);
  const userEmail = text(email, 320);
  if (!userId || !userEmail) return undefined;
  const userName = text(name, MAX_LABEL_CHARS);
  const userAvatar = text(avatarUrl, MAX_HREF_CHARS);
  return { id: userId, email: userEmail, ...(userName ? { name: userName } : {}), ...(userAvatar ? { avatarUrl: userAvatar } : {}) };
}

/**
 * Asks the extension for its session. Null when the extension has none (the
 * person signed out there) or does not answer in time. `renew` asks it to
 * renew its access token first: the token names the account, so one issued
 * before the account was renamed keeps saying the old name until it is renewed.
 */
export function requestEmbedSession(parent: string, { renew = false, timeoutMs = 10_000 }:
  { renew?: boolean; timeoutMs?: number } = {}): Promise<EmbedSession | null> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (session: EmbedSession | null) => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve(session);
    };
    const onMessage = (event: MessageEvent) => {
      const data = fromParent(event, parent);
      if (!data || data.id !== id) return;
      if (data.type === "session" && typeof data.token === "string" && data.token.length < 8_192) {
        const user = parseEmbedUser(data.user);
        done({ token: data.token, ...(user ? { user } : {}) });
      } else if (data.type === "signed-out") done(null);
    };
    const timer = window.setTimeout(() => done(null), timeoutMs);
    window.addEventListener("message", onMessage);
    postToParent(parent, { type: "session-request", id, ...(renew ? { renew: true } : {}) });
  });
}

/** Tells the extension the account as the Hub has it now, which it opens the app with next time. */
export function announceEmbedAccount(parent: string, user: AuthUser) {
  postToParent(parent, { type: "account", user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } });
}

/**
 * Tells the extension the Space this app is showing. A question the person
 * asks right on a page goes to this Space, the one they are looking at in the
 * panel, not to whichever Space happens to be listed first.
 */
export function announceEmbedSpace(space: { id: string; name: string }) {
  const parent = extensionEmbedParent();
  if (parent) postToParent(parent, { type: "space", space: { id: space.id, name: space.name.slice(0, MAX_LABEL_CHARS) } });
}

/** Tells the extension the person signed out here, so it ends its own session too. */
export function announceEmbedSignOut(parent: string) {
  postToParent(parent, { type: "signed-out" });
}

/**
 * Tells the extension the Hub no longer admits this build of the app: the
 * panel asks for the extension to be updated, where the Web shows its upgrade page.
 */
export function announceEmbedUpgradeRequired(parent: string) {
  postToParent(parent, { type: "upgrade-required" });
}

/** The extension ended its session (the person signed out in the side panel). */
export function subscribeEmbedSignOut(parent: string, onSignedOut: () => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (fromParent(event, parent)?.type === "signed-out") onSignedOut();
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** What the person picked on the page they are reading, and where it goes. */
export type EmbedPassage = {
  /** The selected text; empty when they picked the whole page. */
  text: string;
  /** The page's title. */
  label: string;
  /** The page's address; only http(s). */
  href: string;
  /** Quote it in the open conversation, or start a new conversation with it. */
  target: "current" | "new";
  /** Whether to move keyboard focus into the composer (false when auto-popped on page text selection). */
  focus?: boolean;
  /** Selection on the page IS the quote (#2004): keep the composer clean and prepend the quote on send. */
  implicit?: boolean;
};

/** Validates a passage message: bounded strings, a web address, a known target. */
export function parseEmbedPassage(data: Record<string, unknown>): EmbedPassage | null {
  const { text, label, href, target, focus, implicit } = data;
  if (typeof text !== "string" || typeof label !== "string" || typeof href !== "string") return null;
  if (target !== "current" && target !== "new") return null;
  if (text.length > MAX_PASSAGE_CHARS || label.length > MAX_LABEL_CHARS || href.length > MAX_HREF_CHARS) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!text.trim() && !label.trim()) return null;
  return {
    text,
    label,
    href: url.toString(),
    target,
    ...(focus === false ? { focus: false } : {}),
    ...(implicit === true ? { implicit: true } : {}),
  };
}

/** The framing extension's messages of one type, while the app is open in its side panel. */
function subscribeParent(type: string, onData: (data: Record<string, unknown>) => void): () => void {
  const parent = extensionEmbedParent();
  if (!parent) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = fromParent(event, parent);
    if (data?.type === type) onData(data);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** Passages the extension hands over, while the app is open in its side panel. */
export function subscribeEmbedPassages(onPassage: (passage: EmbedPassage) => void): () => void {
  const stop = subscribeParent("passage", (data) => {
    const passage = parseEmbedPassage(data);
    if (passage) onPassage(passage);
  });
  // The extension waits for this before it sends a passage picked while the app was loading.
  const parent = extensionEmbedParent();
  if (parent) postToParent(parent, { type: "ready" });
  return stop;
}

/** Clears a pending implicit page-selection quote when the inline card minimizes or selection clears. */
export function subscribeEmbedClearPassage(onClear: () => void): () => void {
  return subscribeParent("clear-passage", () => onClear());
}

/** A first message handed straight from the floating ask capsule to the embedded App for 0ms optimistic creation. */
export type EmbedStartConversation = {
  id: string;
  body: string;
  requestKey?: string;
  clientMessageId?: string;
  rawQuestion?: string;
  title?: string;
  spaceId?: string;
  href?: string;
  label?: string;
  invocationSelections?: AgentInvocationSelections;
};

export function parseEmbedStartConversation(data: Record<string, unknown>): EmbedStartConversation | null {
  const { id, body, requestKey, clientMessageId, rawQuestion, title, spaceId, href, label, invocationSelections } = data;
  if (typeof id !== "string" || !id || id.length > 128) return null;
  if (typeof body !== "string" || !body.trim() || body.length > 64 * 1024) return null;
  const cleanHref = href === undefined ? undefined : webAddress(href) ?? undefined;
  return {
    id,
    body,
    ...(typeof requestKey === "string" && requestKey.length >= 8 && requestKey.length <= 128 ? { requestKey } : {}),
    ...(typeof clientMessageId === "string" && clientMessageId.length >= 8 && clientMessageId.length <= 128 ? { clientMessageId } : {}),
    ...(typeof rawQuestion === "string" && rawQuestion.length <= MAX_PASSAGE_CHARS ? { rawQuestion } : {}),
    ...(typeof title === "string" && title.length <= MAX_LABEL_CHARS ? { title } : {}),
    ...(typeof spaceId === "string" && spaceId.length <= 128 ? { spaceId } : {}),
    ...(cleanHref ? { href: cleanHref } : {}),
    ...(typeof label === "string" && label.length <= MAX_LABEL_CHARS ? { label } : {}),
    ...(invocationSelections && typeof invocationSelections === "object"
      ? { invocationSelections: invocationSelections as AgentInvocationSelections }
      : {}),
  };
}

/** Idempotent conversation creation spec registered with the extension's background outbox. */
export type EmbedOutboxChannelCreate = {
  requestKey: string;
  spaceId?: string;
  name?: string;
  body?: string;
  mode: "open" | "closed";
  memberName: string;
  metadata?: Record<string, string | boolean>;
};

/** Durable background outbox entry registered while an extension surface sends a message. */
export type EmbedOutboxEntry = {
  clientMessageId: string;
  userId?: string;
  channelId?: string;
  spaceId?: string;
  channelCreate?: EmbedOutboxChannelCreate;
  body: string;
  invocationSelections?: AgentInvocationSelections;
  metadata?: Record<string, unknown>;
  replyToMessageId?: string;
  appMentions?: unknown[];
  title?: string;
  href?: string;
};

/** Registers an in-flight send with the extension service worker so page close/navigation cannot drop it. */
export function announceEmbedOutboxRegister(entry: EmbedOutboxEntry) {
  const parent = extensionEmbedParent();
  if (parent) postToParent(parent, { type: "outbox-register", entry });
}

/** Confirms (or discards) an in-flight send with the extension service worker so it won't retry. */
export function announceEmbedOutboxAck(clientMessageId: string) {
  const parent = extensionEmbedParent();
  if (parent && clientMessageId) postToParent(parent, { type: "outbox-ack", clientMessageId });
}

/** Subscribes to 0ms optimistic conversation starts sent from the floating ask capsule to the embedded App. */
export function subscribeEmbedStartConversation(onStart: (start: EmbedStartConversation) => void): () => void {
  return subscribeParent("start-conversation", (data) => {
    const parsed = parseEmbedStartConversation(data);
    if (parsed) onStart(parsed);
  });
}

/** Tells the inline popover host to minimize the open conversation card to the right-edge dock tab. */
export function announceEmbedMinimize() {
  const parent = extensionEmbedParent();
  if (parent) postToParent(parent, { type: "minimize" });
}

/** Reports the count of in-flight conversation creates or sends so the host never unmounts mid-send. */
export function announceEmbedPendingSends(count: number) {
  const parent = extensionEmbedParent();
  if (parent) postToParent(parent, { type: "pending-sends", count: Math.max(0, Math.floor(count)) });
}

/** Tells the side panel host that a conversation is now displayed, so any hidden inline App can release. */
export function announceEmbedChannelDisplayed(path: string) {
  const parent = extensionEmbedParent();
  if (parent && APP_CONVERSATION_PATH.test(path)) postToParent(parent, { type: "channel-displayed", path });
}

/** Whether this packaged app frame is rendered inside the extension's on-page inline popover card. */
export function isExtensionInlinePopover(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.inlinePopover === "true";
}

/** A conversation of this app, as `/app/<space>/channels/<conversation>`; nothing else. */
const APP_CONVERSATION_PATH = /^\/app\/[A-Za-z0-9_-]{1,128}\/channels\/[A-Za-z0-9_-]{1,128}$/u;
/** A conversation open address, optionally targeting a specific card/message (`#message:<id>`). */
const APP_CONVERSATION_OPEN_PATH = /^\/app\/[A-Za-z0-9_-]{1,128}\/channels\/[A-Za-z0-9_-]{1,128}(?:#message:[A-Za-z0-9_.%:-]{1,256})?$/u;

let inlineHostTabId: number | null = null;

function resolveInlineHostTabId(): number | null {
  if (inlineHostTabId !== null) return inlineHostTabId;
  const search = typeof window !== "undefined" ? window.location?.search : undefined;
  if (!search) return null;
  const raw = Number(new URLSearchParams(search).get("tab"));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Opens this tab's Chrome side panel directly from an inline-card click gesture
 * (optionally jumping straight to `messageId`) so approval/decision cards are
 * never acted on inside an untrusted web-page overlay.
 */
export function openEmbedSidePanel(options?: { spaceId?: string; channelId?: string; messageId?: string }) {
  const cleanMessageId = typeof options?.messageId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(options.messageId)
    ? options.messageId
    : undefined;
  const parent = extensionEmbedParent();
  if (parent) {
    postToParent(parent, {
      type: "dock-to-panel",
      ...(options?.spaceId ? { spaceId: options.spaceId } : {}),
      ...(options?.channelId ? { channelId: options.channelId } : {}),
      ...(cleanMessageId ? { messageId: cleanMessageId } : {}),
    });
  }
  const hostTabId = resolveInlineHostTabId();
  if (hostTabId !== null) {
    const sidePanel = (globalThis as unknown as {
      chrome?: { sidePanel?: { open?: (opts: { tabId: number }) => Promise<void> } };
    }).chrome?.sidePanel;
    void sidePanel?.open?.({ tabId: hostTabId })?.catch?.(() => undefined);
  }
}

/**
 * What shows an address of this app in the open app; false when it shows
 * nothing for it. `channel` is the conversation at that address as the Hub
 * answered its creation, when the extension just started it: the open app may
 * not list it yet.
 */
/**
 * A question the extension is sending to the conversation it opens (asked in the box on a page): the panel shows it
 * as sending at once, under the id the extension sends it with, instead of waiting for the Hub to have it.
 */
export type EmbedPendingMessage = { clientMessageId: string; body: string; metadata?: Record<string, unknown> };

type AddressOpener = (path: string, channel?: SerializedChannel, pending?: EmbedPendingMessage) => boolean;

/** A pending question the extension hands over: its id, bounded text, and the page it was asked on. */
export function parseEmbedPendingMessage(value: unknown): EmbedPendingMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { clientMessageId, body, metadata } = value as Record<string, unknown>;
  if (typeof clientMessageId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(clientMessageId)) return undefined;
  if (typeof body !== "string" || !body.trim() || body.length > 64 * 1024) return undefined;
  const page = browserPageOf(metadata);
  return { clientMessageId, body, ...(page ? { metadata: browserPageMetadata(page) } : {}) };
}

/** A conversation the extension hands over with an address: the one at that address, and bounded. */
function parseOpenedChannel(value: unknown, path: string): SerializedChannel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, spaceId } = value as { id?: unknown; spaceId?: unknown };
  const basePath = path.split("#")[0] ?? path;
  if (typeof id !== "string" || typeof spaceId !== "string" || !basePath.endsWith(`/channels/${id}`)) return undefined;
  return JSON.stringify(value).length <= 256_000 ? value as SerializedChannel : undefined;
}
const addressOpeners = new Set<AddressOpener>();

/**
 * Shows addresses of this app in the open app: conversations the extension
 * started on its own (a question asked on the page, sent straight to the Hub)
 * and asks the panel to show, and addresses the packaged page is asked to
 * navigate to (`openEmbedAddress`).
 */
export function subscribeEmbedOpen(onOpen: AddressOpener): () => void {
  addressOpeners.add(onOpen);
  const stop = subscribeParent("open", (data) => {
    if (typeof data.path === "string" && APP_CONVERSATION_OPEN_PATH.test(data.path)) {
      onOpen(data.path, parseOpenedChannel(data.channel, data.path), parseEmbedPendingMessage(data.pending));
    }
  });
  const stopHostTab = subscribeParent("host-tab", (data) => {
    if (typeof data.tabId === "number" && Number.isInteger(data.tabId) && data.tabId > 0) {
      inlineHostTabId = data.tabId;
    }
  });
  return () => {
    addressOpeners.delete(onOpen);
    stop();
    stopHostTab();
  };
}

/** Shows `path`, an address of this app, in the open app; false when the app is not open or has no view for it. */
export function openEmbedAddress(path: string): boolean {
  for (const open of addressOpeners) if (open(path)) return true;
  return false;
}

/**
 * The page beside the side panel, as the extension tells it: the panel is a
 * companion to that page (Daniel 2026-11-23), not a whole workspace. `path`
 * is the conversation already started from this page. The page's content is
 * not handed over here: an Agent reads it, as its accessibility snapshot, with
 * `xmatrix browse` (Daniel 2026-11-24: a web page is not a file).
 */
export type EmbedPage = { title: string; href: string; path?: string };

/** One conversation started from the extension, for the panel's Recent list. */
export type EmbedRecent = { path: string; title: string; href: string };

function webAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_HREF_CHARS) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** Validates a page message: a web address, a bounded title, an app conversation path. */
export function parseEmbedPage(data: Record<string, unknown>): EmbedPage | null {
  const href = webAddress(data.href);
  const title = boundedText(data.title, MAX_LABEL_CHARS);
  if (!href || title === null) return null;
  const path = typeof data.path === "string" && APP_CONVERSATION_PATH.test(data.path) ? data.path : undefined;
  return { title, href, ...(path ? { path } : {}) };
}

/** Validates the Recent list: at most a few conversations, each an app path with a web page. */
export function parseEmbedRecent(value: unknown): EmbedRecent[] {
  if (!Array.isArray(value)) return [];
  const recent: EmbedRecent[] = [];
  for (const item of value.slice(0, 10)) {
    if (!item || typeof item !== "object") continue;
    const { path, title, href } = item as Record<string, unknown>;
    const page = webAddress(href);
    const name = boundedText(title, MAX_LABEL_CHARS);
    if (typeof path === "string" && APP_CONVERSATION_PATH.test(path) && page && name !== null) {
      recent.push({ path, title: name, href: page });
    }
  }
  return recent;
}

/** Whether this app is the extension's side panel: the companion of the page beside it. */
export function isExtensionCompanion(): boolean {
  return extensionEmbedParent() !== null;
}

/** The page beside the panel, each time it changes. */
export function subscribeEmbedPage(onPage: (page: EmbedPage) => void): () => void {
  return subscribeParent("page", (data) => {
    const page = parseEmbedPage(data);
    if (!page) return;
    if (pageBesidePanel?.href !== page.href || pageBesidePanel.title !== page.title) {
      pageBesidePanel = { title: page.title, href: page.href };
      notifyBrowserPage();
    }
    onPage(page);
  });
}

/** The page beside the side panel, as it last said (subscribeEmbedPage). */
let pageBesidePanel: { title: string; href: string } | null = null;
/** A page the person took off what they write, by its address: another page goes with their messages again. */
let leftOutPage: string | null = null;
const browserPageListeners = new Set<() => void>();
function notifyBrowserPage() {
  for (const listener of browserPageListeners) listener();
}

/**
 * The page the person is looking at while they write in the side panel: each
 * message sent there carries it (browserPageMetadata), so the conversation and
 * its Agents know which page it is about, and the composer shows it. Null
 * outside the side panel, or once the person took this page off.
 */
export function embedBrowserPage(): { title: string; href: string } | null {
  if (!extensionEmbedParent() || !pageBesidePanel || pageBesidePanel.href === leftOutPage) return null;
  return pageBesidePanel;
}

/** Takes the page beside the panel off what the person writes (the composer's page chip, ×), until they move on. */
export function leaveOutEmbedBrowserPage() {
  if (!pageBesidePanel) return;
  leftOutPage = pageBesidePanel.href;
  notifyBrowserPage();
}

/** Each time the page that goes with what is written changes: another page, or the person took it off. */
export function subscribeEmbedBrowserPage(onChange: () => void): () => void {
  browserPageListeners.add(onChange);
  return () => browserPageListeners.delete(onChange);
}

/** The conversations started from the extension, newest first, each time the list changes. */
export function subscribeEmbedRecent(onRecent: (recent: EmbedRecent[]) => void): () => void {
  return subscribeParent("recent", (data) => onRecent(parseEmbedRecent(data.recent)));
}

/** Tells the extension a conversation was started or opened for this tab. */
export function announceEmbedPageThread(thread: { path: string; title: string; href: string; recordRecent?: boolean }) {
  const parent = extensionEmbedParent();
  if (parent && APP_CONVERSATION_PATH.test(thread.path)) postToParent(parent, { type: "page-thread", ...thread });
}

/** Tells the extension this tab's bound conversation is gone or reset; optional `draft`/`error` restores unsent text. */
export function announceEmbedClearPageThread(options?: { draft?: string; error?: string }) {
  const parent = extensionEmbedParent();
  if (parent) {
    postToParent(parent, {
      type: "clear-page-thread",
      ...(typeof options?.draft === "string" && options.draft ? { draft: options.draft.slice(0, MAX_PASSAGE_CHARS) } : {}),
      ...(typeof options?.error === "string" && options.error ? { error: options.error.slice(0, 500) } : {}),
    });
  }
}

/**
 * An Agent asks to read a page through this person's browser (the Hub's
 * `browser_read_requested` frame): the side panel reads it and answers the Hub.
 * Only the extension's side panel takes it; other clients of the person ignore it.
 */
export function forwardEmbedBrowserRead(request: { requestId: string; channelId: string; target: string; agentName: string }) {
  const parent = extensionEmbedParent();
  if (parent) postToParent(parent, { type: "browser-read", ...request });
}

/** A tab the Agent asked to read, waiting for the person to allow it. */
export type EmbedBrowserReadApproval = { requestId: string; agentName: string; title: string; href: string };

/** Requests to read another tab, which the person allows or refuses in the panel. */
export function subscribeEmbedBrowserReadApprovals(onApproval: (approval: EmbedBrowserReadApproval) => void): () => void {
  return subscribeParent("browser-read-approve", (data) => {
    const href = webAddress(data.href);
    const title = boundedText(data.title, MAX_LABEL_CHARS);
    const agentName = boundedText(data.agentName, MAX_LABEL_CHARS);
    if (typeof data.requestId === "string" && data.requestId.length <= 80 && href && title !== null && agentName !== null) {
      onApproval({ requestId: data.requestId, agentName, title, href });
    }
  });
}

/** The person's choice for a tab an Agent asked to read. */
export function answerEmbedBrowserReadApproval(requestId: string, allow: boolean) {
  const parent = extensionEmbedParent();
  if (parent) postToParent(parent, { type: "browser-read-approval", requestId, allow });
}

type ChromeExternalRuntime = {
  lastError?: { message?: string };
  sendMessage: (
    extensionId: string,
    message: Record<string, unknown>,
    callback: (response?: { ok?: boolean; value?: unknown }) => void,
  ) => void;
};

const PLAY_BUCKET_PATTERN = /^pubsite_prod(?:_rev)?_[0-9]{6,30}$/u;

export type PlayConsoleBucketResult =
  | { status: "found"; buckets: string[] }
  | { status: "not-found"; downloadReportsUrl?: string }
  | { status: "no-tab" }
  | { status: "no-permission" }
  | { status: "unavailable" };

function playConsoleAddress(value: unknown): string | undefined {
  const clean = webAddress(value);
  if (!clean) return undefined;
  try {
    const parsed = new URL(clean);
    return parsed.protocol === "https:" && parsed.hostname === "play.google.com"
      && (parsed.pathname === "/console" || parsed.pathname.startsWith("/console/"))
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the installed xMatrix Chrome extension to detect plain `pubsite_prod_rev_*`
 * bucket IDs from an open Google Play Console tab (never cookies or other page data).
 */
export function requestPlayConsoleBucket({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<PlayConsoleBucketResult> {
  const runtime = browserExtensionRuntime();
  if (!runtime) return Promise.resolve({ status: "unavailable" });
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: PlayConsoleBucketResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    const timer = window.setTimeout(() => done({ status: "unavailable" }), timeoutMs);
    try {
      runtime.sendMessage(EXTENSION_ID, { protocol: PROTOCOL, type: "google-play-bucket" }, (response) => {
        if (runtime.lastError || !response?.ok || !response.value || typeof response.value !== "object") {
          done({ status: "unavailable" });
          return;
        }
        const value = response.value as Record<string, unknown>;
        if (value.status === "found" && Array.isArray(value.buckets)) {
          const buckets = [...new Set(value.buckets.filter((item): item is string =>
            typeof item === "string" && PLAY_BUCKET_PATTERN.test(item)))].slice(0, 10);
          done(buckets.length > 0 ? { status: "found", buckets } : { status: "not-found" });
          return;
        }
        if (value.status === "not-found") {
          const downloadReportsUrl = playConsoleAddress(value.downloadReportsUrl);
          done({ status: "not-found", ...(downloadReportsUrl ? { downloadReportsUrl } : {}) });
          return;
        }
        if (value.status === "no-tab" || value.status === "no-permission") {
          done({ status: value.status });
          return;
        }
        done({ status: "unavailable" });
      });
    } catch {
      done({ status: "unavailable" });
    }
  });
}

function browserExtensionRuntime(): ChromeExternalRuntime | null {
  if (typeof window === "undefined") return null;
  const runtime = (window as unknown as { chrome?: { runtime?: Partial<ChromeExternalRuntime> } }).chrome?.runtime;
  return typeof runtime?.sendMessage === "function" ? (runtime as ChromeExternalRuntime) : null;
}

/**
 * Brings a web page the person wrote from back into view: the tab already
 * showing it (this panel's own tab first), not a new one (Daniel 2026-11-24).
 * Works both inside the Chrome extension side panel (via postMessage) and in
 * the xMatrix Web app on Chrome when the extension is installed (via
 * externally_connectable). Falls back to opening a new tab when the extension
 * is absent or no tab shows the page any more.
 */
export function showEmbedWebPage(href: string): boolean {
  const clean = webAddress(href);
  if (!clean) return false;
  const parent = extensionEmbedParent();
  if (parent) {
    postToParent(parent, { type: "show-page", href: clean });
    return true;
  }
  const runtime = browserExtensionRuntime();
  if (!runtime) return false;
  try {
    runtime.sendMessage(EXTENSION_ID, { protocol: PROTOCOL, type: "show-page", href: clean }, (response) => {
      if (runtime.lastError || !response?.ok) {
        window.open(clean, "_blank", "noopener,noreferrer");
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** Plain left-click handler for a "Web page" link: switches back to the person's tab when possible. */
export function openWebPageLink(
  event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void },
  href: string,
) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (showEmbedWebPage(href)) event.preventDefault();
}

/** Opens an address in a browser tab of its own, from the panel. */
export function openEmbedInTab(href: string) {
  const parent = extensionEmbedParent();
  if (parent && webAddress(href)) postToParent(parent, { type: "open-tab", href });
}

/**
 * The extension's question box on a web page (extension-app/ask.tsx) is a
 * packaged page of the extension too, framed by the page it asks about, not
 * by the side panel. It names itself as the same client.
 */
let askSurface = false;
let askToken: string | null = null;
/** Marks this page as the question box, holding the access token the extension handed it for calls that carry none. */
export function markExtensionAskSurface(token: string) {
  askSurface = true;
  askToken = token;
}

/** The question box's access token, when this page is the question box. */
export function extensionAskToken(): string | null {
  return askSurface ? askToken : null;
}

/**
 * The side panel's client identity, sent on its calls to the Hub
 * (extension-app/hub-proxy.ts). The Hub judges it on every call.
 */
export function embedClientCompatibilityHeaders(): Record<string, string> {
  if (!extensionEmbedParent() && !askSurface) return {};
  return clientCompatibilityHeaders({
    component: "app",
    version: canonicalVersion.version,
    protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
    platform: EXTENSION_CLIENT_PLATFORM,
  });
}
