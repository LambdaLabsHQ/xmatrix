import { BrowserWindow, session, shell } from "electron";
import { allowedInSignIn, sessionCookieHeader, SIGN_IN_SERVICES, type SignInServiceId } from "./sign-in-services";
import { planWindowOpen } from "./window-navigation";

/*
 * The window a connector is signed in from (sign-in-services.ts). One per
 * service at a time; asking again brings it forward. A profile still signed in
 * answers at once, without a window, which is what renewing a session usually
 * comes to.
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
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
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
