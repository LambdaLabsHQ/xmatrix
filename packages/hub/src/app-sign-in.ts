import { base64UrlEncodeBytes } from "./relay-v2-primitives";

/**
 * Signing an app in with Google or GitHub, in place (RFC 8252): the app opens
 * the provider's page in the system's sign-in sheet or browser, and gets back
 * a one-time code that only it can redeem, because only it holds the PKCE
 * verifier the flow was started with. No device code is compared and nothing
 * is approved by hand: the person who signs in at the provider is the one in
 * front of the app.
 */

/** How long a started sign-in may take at the provider. */
export const APP_SIGN_IN_FLOW_TTL_MS = 10 * 60 * 1000;
/** How long the app has to redeem its code once the provider answered. */
export const APP_SIGN_IN_CODE_TTL_MS = 2 * 60 * 1000;

export const APP_SIGN_IN_PROVIDERS = ["google", "github"] as const;
export type AppSignInProvider = (typeof APP_SIGN_IN_PROVIDERS)[number];

/** Where a phone app is called back: its registered scheme, intercepted by the sign-in sheet. */
const APP_SCHEME_CALLBACK = "xmatrix://auth";

/**
 * The address the code goes back to. Only the app's own scheme, or a loopback
 * port on the computer the desktop app runs on; anything else could hand the
 * code to someone else.
 */
export function appSignInRedirectUri(value: string | undefined): string | null {
  if (!value) return null;
  if (value === APP_SCHEME_CALLBACK) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !Number.isInteger(port) || port < 1024 || url.username || url.password
    || url.pathname !== "/callback" || url.search || url.hash) {
    return null;
  }
  return url.toString();
}

/** A PKCE S256 challenge: base64url of a SHA-256 digest, 43 characters. */
export function isPkceChallenge(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

/** The app's own value, echoed back so it can tell its answer from someone else's. */
export function isAppSignInState(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
}

/** Whether `verifier` is the one the flow's challenge was made from (RFC 7636 S256). */
export async function pkceVerifierMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncodeBytes(new Uint8Array(digest)) === challenge;
}

/** The app's callback, carrying either the code or the reason there is none. */
export function appSignInCallback(redirectUri: string, state: string,
  answer: { code: string; newAccount?: boolean } | { error: string }): string {
  const url = new URL(redirectUri);
  if ("code" in answer) {
    url.searchParams.set("code", answer.code);
    if (answer.newAccount) url.searchParams.set("new_account", "1");
  } else url.searchParams.set("error", answer.error);
  url.searchParams.set("state", state);
  return url.toString();
}
