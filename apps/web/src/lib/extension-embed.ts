"use client";

/**
 * The app inside the xMatrix Chrome extension's side panel.
 *
 * A frame in an extension page gets none of the site's cookies, so the panel
 * cannot use the browser's web session. The extension holds its own session
 * (the CLI device sign-in) and hands this frame only a short-lived access
 * token, on request, over `postMessage`. The token stays in memory; the
 * refresh token never leaves the extension. Every message is checked both
 * ways: this frame answers only the parent whose origin is on
 * EXTENSION_EMBED_ORIGINS and posts only to that origin.
 *
 * The extension also hands over what the person picked on the page they are
 * reading (a passage, or the page itself), to quote in the open conversation
 * or to start a new one with.
 */
import { CLIENT_COMPATIBILITY_POLICY, clientCompatibilityHeaders } from "@xmatrix/protocol";
import canonicalVersion from "../../../../version.json" with { type: "json" };
import { EXTENSION_EMBED_ORIGINS } from "./extension-embed-origins";

const PROTOCOL = "xmatrix-embed/1";
const MAX_PASSAGE_CHARS = 20_000;
const MAX_LABEL_CHARS = 300;
const MAX_HREF_CHARS = 2_000;

/** The extension origin framing this app, or null when it is not in the side panel. */
export function extensionEmbedParent(): string | null {
  if (typeof window === "undefined" || window.parent === window) return null;
  const origin = window.location.ancestorOrigins?.[0];
  return origin && EXTENSION_EMBED_ORIGINS.includes(origin) ? origin : null;
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

/**
 * Asks the extension for a current access token. Null when the extension has
 * no session (the person signed out there) or does not answer in time.
 */
export function requestEmbedToken(parent: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (token: string | null) => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve(token);
    };
    const onMessage = (event: MessageEvent) => {
      const data = fromParent(event, parent);
      if (!data || data.id !== id) return;
      if (data.type === "session" && typeof data.token === "string" && data.token.length < 8_192) done(data.token);
      else if (data.type === "signed-out") done(null);
    };
    const timer = window.setTimeout(() => done(null), timeoutMs);
    window.addEventListener("message", onMessage);
    postToParent(parent, { type: "session-request", id });
  });
}

/** Tells the extension the person signed out here, so it ends its own session too. */
export function announceEmbedSignOut(parent: string) {
  postToParent(parent, { type: "signed-out" });
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

/** Passages the extension hands over, while the app is open in its side panel. */
export function subscribeEmbedPassages(onPassage: (passage: EmbedPassage) => void): () => void {
  const parent = extensionEmbedParent();
  if (!parent) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = fromParent(event, parent);
    if (data?.type !== "passage") return;
    const passage = parseEmbedPassage(data);
    if (passage) onPassage(passage);
  };
  window.addEventListener("message", onMessage);
  // The extension waits for this before it sends a passage picked while the app was loading.
  postToParent(parent, { type: "ready" });
  return () => window.removeEventListener("message", onMessage);
}

/** A conversation of this app, as `/app/<space>/<conversation>`; nothing else. */
const APP_CONVERSATION_PATH = /^\/app\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/u;

/**
 * Conversations the extension started on its own (a question asked on the
 * page, sent straight to the Hub) and asks the panel to show.
 */
export function subscribeEmbedOpen(onOpen: (path: string) => void): () => void {
  const parent = extensionEmbedParent();
  if (!parent) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = fromParent(event, parent);
    if (data?.type === "open" && typeof data.path === "string" && APP_CONVERSATION_PATH.test(data.path)) onOpen(data.path);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/**
 * The side panel's client identity, sent on the Web's own proxy calls: the
 * compatibility cookie the proxy reads elsewhere is never set in a frame
 * without cookies. The Hub still judges this identity on every call.
 */
export function embedClientCompatibilityHeaders(): Record<string, string> {
  if (!extensionEmbedParent()) return {};
  return clientCompatibilityHeaders({
    component: "app",
    version: canonicalVersion.version,
    protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
    platform: "chrome-extension",
  });
}
