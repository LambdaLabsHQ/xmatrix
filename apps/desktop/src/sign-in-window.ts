import { BrowserWindow, session, shell } from "electron";
import { allowedInSignIn, sessionCookieHeader, SIGN_IN_SERVICES, type SignInServiceId } from "./sign-in-services";
import { planWindowOpen } from "./window-navigation";

/*
 * The window a connector is signed in from (sign-in-services.ts). One per
 * service at a time; asking again brings it forward. A profile still signed in
 * answers at once, without a window, which is what renewing a session usually
 * comes to.
 *
 * Renewing also runs on its own (heldOrRenewedSession): the page asks now and
 * then, while the app runs, and hands what the profile holds to the Hub. The
 * profile's own request keeps the session in use from the person's own network,
 * and a session Apple let lapse is given one chance to come back by loading the
 * service in a window never shown. Nothing here ever shows a window or asks for
 * a password; when the profile is signed out, the person is asked as before.
 */

export type SignInResult = { status: "signed-in"; session: string } | { status: "cancelled" };

const TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 4_000;
const open = new Map<SignInServiceId, { window: BrowserWindow; result: Promise<SignInResult> }>();

const profile = (id: SignInServiceId) => session.fromPartition(`persist:sign-in-${id}`);

function openInBrowser(url: string): void {
  const plan = planWindowOpen(url);
  if (plan.kind === "external") void shell.openExternal(plan.url);
}

/** The session the service's profile holds, or null while it is not signed in. */
async function heldSession(id: SignInServiceId): Promise<string | null> {
  const service = SIGN_IN_SERVICES[id];
  const store = profile(id);
  try {
    const response = await store.fetch(service.probe.url, { credentials: "include", headers: service.probe.headers,
      signal: AbortSignal.timeout(10_000) });
    const body: unknown = response.ok ? await response.json().catch(() => null) : null;
    if (!response.ok) await response.body?.cancel();
    if (!service.probe.accepts(response.status, body)) return null;
  } catch {
    return null;
  }
  return sessionCookieHeader(await store.cookies.get({ url: service.cookieUrl })) || null;
}

const RENEW_MS = 20_000;
const renewing = new Map<SignInServiceId, Promise<string | null>>();

/** Load the service where no one sees it, for a profile Apple signs back in by itself, and answer what it then holds. */
async function renewQuietly(id: SignInServiceId): Promise<string | null> {
  const service = SIGN_IN_SERVICES[id];
  const window = new BrowserWindow({ show: false, width: 980, height: 760,
    webPreferences: { partition: `persist:sign-in-${id}`, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const stay = (event: { preventDefault: () => void }, url: string) => { if (!allowedInSignIn(service, url)) event.preventDefault(); };
  window.webContents.on("will-navigate", stay);
  window.webContents.on("will-redirect", stay);
  window.webContents.setAudioMuted(true);
  try {
    void window.loadURL(service.start).catch(() => undefined);
    const deadline = Date.now() + RENEW_MS;
    while (Date.now() < deadline && !window.isDestroyed()) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const held = await heldSession(id);
      if (held) return held;
    }
    return null;
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

/**
 * The session the profile holds, renewed without a window if it can be; null
 * when only the person can sign in again. Never opens anything they see.
 */
export function heldOrRenewedSession(id: SignInServiceId): Promise<string | null> {
  if (open.has(id)) return Promise.resolve(null);
  const pending = renewing.get(id) ?? (async () => (await heldSession(id)) ?? (await renewQuietly(id)))()
    .catch(() => null).finally(() => renewing.delete(id));
  renewing.set(id, pending);
  return pending;
}

export async function signInWithWindow(id: SignInServiceId, parent: BrowserWindow | null,
  options: { fresh?: boolean } = {}): Promise<SignInResult> {
  const current = open.get(id);
  if (current && !current.window.isDestroyed()) {
    current.window.focus();
    return current.result;
  }
  // Another account: forget the one this profile is signed in to.
  if (options.fresh) await profile(id).clearStorageData();
  else {
    const held = await heldSession(id);
    if (held) return { status: "signed-in", session: held };
  }

  const service = SIGN_IN_SERVICES[id];
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    title: service.title,
    show: false,
    autoHideMenuBar: true,
    // Not a child of the app's window: on a Mac a child of a full-screen window takes over its
    // Space, and closing it left the app's window black (electron#39614). The opener is brought back instead.
    fullscreenable: false,
    webPreferences: { partition: `persist:sign-in-${id}`, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const result = new Promise<SignInResult>((resolve) => {
    let settled = false;
    let checking = false;
    const finish = (value: SignInResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      open.delete(id);
      if (!window.isDestroyed()) window.close();
      if (parent && !parent.isDestroyed()) {
        parent.show();
        parent.focus();
      }
      resolve(value);
    };
    const check = async () => {
      if (checking || settled) return;
      checking = true;
      try {
        const held = await heldSession(id);
        if (held) finish({ status: "signed-in", session: held });
      } finally {
        checking = false;
      }
    };
    const timeout = setTimeout(() => finish({ status: "cancelled" }), TIMEOUT_MS);
    // The website signs in inside a frame and moves on by script; the page
    // events are the quick way to notice, the poll the sure one.
    const poll = setInterval(() => void check(), POLL_MS);

    window.webContents.setWindowOpenHandler(({ url }) => {
      openInBrowser(url);
      return { action: "deny" };
    });
    const stayOnService = (event: { preventDefault: () => void }, url: string) => {
      if (allowedInSignIn(service, url)) return;
      event.preventDefault();
      openInBrowser(url);
    };
    window.webContents.on("will-navigate", stayOnService);
    window.webContents.on("will-redirect", stayOnService);
    window.webContents.on("did-navigate", () => void check());
    window.webContents.on("did-navigate-in-page", () => void check());
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => finish({ status: "cancelled" }));
  });
  open.set(id, { window, result });
  void window.loadURL(service.start);
  return result;
}
