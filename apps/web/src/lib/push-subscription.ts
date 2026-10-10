import { sha256Hex, WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixRawResponse } from "@/lib/query/api-client";

/** Where this browser stands on push: whether it can, whether it is on, and why not. */
export type BrowserPushState = "unsupported" | "unavailable" | "blocked" | "off" | "on";

const WORKER_PATH = "/push-sw.js";
/** The id the Hub knows this phone by, kept so that signing out can forget it. */
const PHONE_DEVICE_KEY = "xmatrix.push.device";

function supported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext &&
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(base64url: string): Uint8Array {
  const binary = atob(base64url.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function request(token: string, route: string, init: RequestInit = {}): Promise<Response> {
  return xmatrixRawResponse(route, { ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
}

/** The Hub's key a browser subscribes with, or null when this Hub does not push to browsers. */
async function hubPushKey(token: string): Promise<string | null> {
  const response = await request(token, WEB_PROXY_ROUTES.push_config);
  if (!response.ok) return null;
  const body = await response.json().catch(() => ({})) as { vapidPublicKey?: unknown };
  return typeof body.vapidPublicKey === "string" && body.vapidPublicKey ? body.vapidPublicKey : null;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(WORKER_PATH);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Register a subscription with the Hub; it answers with the device's id. */
async function registerDevice(token: string, subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  const response = await request(token, WEB_PROXY_ROUTES.push_devices, {
    method: "POST",
    body: JSON.stringify({ platform: "webpush", token: subscription.endpoint, keys: json.keys }),
  });
  if (!response.ok) throw new Error("The Hub did not accept this browser's subscription");
}

export async function browserPushState(token: string): Promise<BrowserPushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (await currentSubscription()) return "on";
  return (await hubPushKey(token)) ? "off" : "unavailable";
}

/**
 * Turn push on for this browser: ask for permission (it must follow a click),
 * subscribe with the Hub's key and register the subscription for this person.
 */
export async function enableBrowserPush(token: string): Promise<BrowserPushState> {
  if (!supported()) return "unsupported";
  const key = await hubPushKey(token);
  if (!key) return "unavailable";
  if ((await Notification.requestPermission()) !== "granted") {
    return Notification.permission === "denied" ? "blocked" : "off";
  }
  const registration = await navigator.serviceWorker.register(WORKER_PATH, { scope: "/" });
  await navigator.serviceWorker.ready;
  const subscription = (await registration.pushManager.getSubscription()) ?? await registration.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: keyBytes(key).buffer as ArrayBuffer,
  });
  await registerDevice(token, subscription);
  return "on";
}

/** Turn push off for this browser, and tell the Hub to forget it. */
export async function disableBrowserPush(token: string): Promise<BrowserPushState> {
  if (!supported()) return "unsupported";
  const subscription = await currentSubscription();
  if (subscription) {
    // The Hub names a device by the digest of its platform and token.
    const deviceId = await sha256Hex(`webpush\n${subscription.endpoint}`);
    await request(token, WEB_PROXY_ROUTES.push_device(deviceId), { method: "DELETE" }).catch(() => undefined);
    await subscription.unsubscribe();
  }
  return browserPushState(token);
}

function phoneStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/**
 * In a phone app, register the device its system gave it. The app asks for
 * notification permission the first time; a refusal registers nothing.
 */
export async function registerPhonePush(token: string): Promise<void> {
  const device = await getDesktopBridge()?.pushDevice?.();
  if (!device) return;
  const response = await request(token, WEB_PROXY_ROUTES.push_devices, { method: "POST", body: JSON.stringify(device) });
  if (response.ok) phoneStore()?.setItem(PHONE_DEVICE_KEY, await sha256Hex(`${device.platform}\n${device.token}`));
}

/** Tell the Hub to forget this phone, as signing out does. */
export async function forgetPhonePush(token: string): Promise<void> {
  const deviceId = phoneStore()?.getItem(PHONE_DEVICE_KEY);
  if (!deviceId) return;
  await request(token, WEB_PROXY_ROUTES.push_device(deviceId), { method: "DELETE" });
  phoneStore()?.removeItem(PHONE_DEVICE_KEY);
}
