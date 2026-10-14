/*
 * Services a connector can be signed in to from the app's own window, as data
 * the window and its tests share. The person signs in on the service's own
 * pages; the app only reads, afterwards, the session cookies the window holds
 * and hands them to the page, which saves them as the connector's credential.
 * The password never leaves the service's page.
 *
 * Each service keeps its sign-in in a profile of its own, apart from xMatrix's
 * window and from the person's browser, and the window shows only that
 * service's pages: any other link opens in the browser.
 */

export type SignInServiceId = "appstoreconnect";

export interface SignInService {
  title: string;
  /** The page the window opens on. */
  start: string;
  /** Hosts the window may show over HTTPS; a link anywhere else opens in the browser. */
  hosts: (hostname: string) => boolean;
  /** Asked as the window moves: whether its profile now holds a signed-in session. */
  probe: { url: string; headers: Record<string, string>; accepts: (status: number, body: unknown) => boolean };
  /** The cookies sent to this address are the session handed over. */
  cookieUrl: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const SIGN_IN_SERVICES: Record<SignInServiceId, SignInService> = {
  appstoreconnect: {
    title: "Sign in to App Store Connect",
    start: "https://appstoreconnect.apple.com/login",
    hosts: (hostname) => hostname === "apple.com" || hostname.endsWith(".apple.com"),
    // The website's own account endpoint: a team and a user once signed in, 401 before.
    probe: {
      url: "https://appstoreconnect.apple.com/olympus/v1/session",
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
      accepts: (status, body) => status === 200 && record(body) && record(body.user) && record(body.provider),
    },
    cookieUrl: "https://appstoreconnect.apple.com/",
  },
};

export function signInServiceId(value: unknown): SignInServiceId | null {
  return typeof value === "string" && Object.hasOwn(SIGN_IN_SERVICES, value) ? value as SignInServiceId : null;
}

/** Whether the sign-in window may show this address itself. */
export function allowedInSignIn(service: SignInService, value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && service.hosts(url.hostname);
  } catch {
    return false;
  }
}

/** The Cookie header, as a browser would send it, from the cookies the window holds for the service. */
export function sessionCookieHeader(cookies: ReadonlyArray<{ name: string; value: string }>): string {
  return cookies
    .filter((cookie) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(cookie.name) && cookie.value && !/[\s;,\\]/u.test(cookie.value))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
