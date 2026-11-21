/**
 * Where a navigation goes in the app bundled into the Chrome extension.
 *
 * The page is one packaged file; the shell writes its address (`/app/<space>/...`)
 * with `history` and never loads another document. Everything else that would
 * load one is decided here, through the Navigation API:
 *
 * - an address of the app (a link to a conversation or a page) is shown in place, by the shell itself;
 * - a reload loads the packaged file again and returns to the same address;
 * - the Web's sign-in and upgrade pages are the extension's to show: the frame
 *   tells the panel, which signs in again or asks for an update;
 * - any other address opens in a browser tab, the app's own pages on the Web.
 */
import {
  announceEmbedSignOut,
  announceEmbedUpgradeRequired,
  extensionEmbedParent,
  openEmbedAddress,
} from "@/lib/extension-embed";
import { isAppShellPath } from "@/lib/app-shell-route";
import { appUrl } from "@/lib/site-url";

/** The packaged document: the only one this frame may load. */
const DOCUMENT_PATH = window.location.pathname;
const RESUME_PARAMETER = "at";

function appAddress(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/** An address the shell answers; a legacy `/app/<space>/<conversation>` link, which a Web route redirects, in the shell's form. */
function shellAddress(url: URL): URL | null {
  if (isAppShellPath(url.pathname)) return url;
  const legacy = /^\/app\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
  if (!legacy) return null;
  const next = new URL(url);
  next.pathname = `/app/${legacy[1]}/channels/${legacy[2]}`;
  return isAppShellPath(next.pathname) ? next : null;
}

/** The same address on the Web, in a browser tab. */
function openOnWeb(url: URL): void {
  window.open(new URL(appAddress(url), appUrl), "_blank", "noopener");
}

type NavigateEvent = Event & {
  navigationType: "push" | "replace" | "reload" | "traverse";
  destination: { url: string; sameDocument: boolean };
  hashChange: boolean;
  downloadRequest: string | null;
  formData: FormData | null;
};

function onNavigate(event: NavigateEvent): void {
  if (event.destination.sameDocument || event.hashChange || event.downloadRequest !== null || event.formData) return;
  const url = new URL(event.destination.url);
  const sameOrigin = url.origin === window.location.origin;
  if (sameOrigin && url.pathname === DOCUMENT_PATH) return;
  if (!event.cancelable) return;
  event.preventDefault();

  if (event.navigationType === "reload") {
    const reload = new URL(DOCUMENT_PATH, window.location.origin);
    reload.searchParams.set(RESUME_PARAMETER, appAddress(new URL(window.location.href)));
    window.location.replace(reload);
    return;
  }
  if (!sameOrigin) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const parent = extensionEmbedParent();
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) {
    if (parent) announceEmbedSignOut(parent);
    return;
  }
  if (url.pathname === "/upgrade-required") {
    if (parent) announceEmbedUpgradeRequired(parent);
    return;
  }
  // The open shell shows its own addresses (a conversation, a page); a view it has no link into opens on the Web.
  const shell = shellAddress(url);
  if (!shell || !openEmbedAddress(appAddress(shell))) openOnWeb(url);
}

/**
 * Puts the frame on the address it was opened for (`?at=/app/...`, from the
 * panel or a reload), before the shell reads it, and starts deciding navigations.
 */
export function startNavigation(): void {
  const asked = new URL(window.location.href).searchParams.get(RESUME_PARAMETER);
  let start: URL | null = null;
  try {
    start = asked ? shellAddress(new URL(asked, window.location.origin)) : null;
  } catch {
    start = null;
  }
  window.history.replaceState(null, "", start && start.origin === window.location.origin ? appAddress(start) : "/app");
  (window as unknown as { navigation?: EventTarget }).navigation
    ?.addEventListener("navigate", (event) => onNavigate(event as NavigateEvent));
}
