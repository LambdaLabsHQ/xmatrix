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
import { CLIENT_COMPATIBILITY_POLICY, clientCompatibilityHeaders, type AuthUser } from "@xmatrix/protocol";
import canonicalVersion from "../../../../version.json" with { type: "json" };
import { EXTENSION_EMBED_ORIGINS } from "./extension-embed-origins";

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
};

/** Validates a passage message: bounded strings, a web address, a known target. */
export function parseEmbedPassage(data: Record<string, unknown>): EmbedPassage | null {
  const { text, label, href, target } = data;
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
  return { text, label, href: url.toString(), target };
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

/** A conversation of this app, as `/app/<space>/channels/<conversation>`; nothing else. */
const APP_CONVERSATION_PATH = /^\/app\/[A-Za-z0-9_-]{1,128}\/channels\/[A-Za-z0-9_-]{1,128}$/u;

/** What shows an address of this app in the open app; false when it shows nothing for it. */
type AddressOpener = (path: string) => boolean;
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
    if (typeof data.path === "string" && APP_CONVERSATION_PATH.test(data.path)) onOpen(data.path);
  });
  return () => {
    addressOpeners.delete(onOpen);
    stop();
  };
}

/** Shows `path`, an address of this app, in the open app; false when the app is not open or has no view for it. */
export function openEmbedAddress(path: string): boolean {
  for (const open of addressOpeners) if (open(path)) return true;
  return false;
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
