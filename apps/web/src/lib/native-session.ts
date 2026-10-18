import { HUB_ROUTES, type AuthResponse, withRoute } from "@xmatrix/protocol";
import { getXMatrixHubUrl } from "@/lib/xmatrix";

/** Every cookie the web app sets itself: HTTP-only, secure, site-wide, kept for a week. */
export const FIRST_PARTY_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
} as const;

export const NATIVE_ACCESS_COOKIE = "xmatrix_native_access_token";
export const NATIVE_REFRESH_COOKIE = "xmatrix_native_refresh_token";
export const NATIVE_PROVIDER_COOKIE = "xmatrix_native_auth_provider";

type CookieOptions = Omit<typeof FIRST_PARTY_COOKIE_OPTIONS, "maxAge"> & { maxAge: number };

/** A request's cookie store or a response's cookies; both write the same way. */
type CookieWriter = { set(name: string, value: string, options: CookieOptions): unknown };

/** As long as the Hub session an app signs in with, so a phone opened weekly stays signed in. */
const NATIVE_SESSION_COOKIE_OPTIONS = { ...FIRST_PARTY_COOKIE_OPTIONS, maxAge: 60 * 60 * 24 * 30 };

export function setNativeSessionCookies(cookies: CookieWriter, payload: AuthResponse) {
  cookies.set(NATIVE_ACCESS_COOKIE, payload.token, NATIVE_SESSION_COOKIE_OPTIONS);
  cookies.set(NATIVE_REFRESH_COOKIE, payload.refreshToken || "", NATIVE_SESSION_COOKIE_OPTIONS);
  cookies.set(NATIVE_PROVIDER_COOKIE, payload.authProvider || "", NATIVE_SESSION_COOKIE_OPTIONS);
}

/** Better Auth's bearer plugin returns a URI-encoded, signed session cookie after rotation. */
export function replaceNativeSessionToken(cookies: CookieWriter, signedToken: string): void {
  const token = decodeURIComponent(signedToken).split(".", 1)[0];
  if (!token) return;
  cookies.set(NATIVE_REFRESH_COOKIE, token, NATIVE_SESSION_COOKIE_OPTIONS);
  cookies.set(NATIVE_ACCESS_COOKIE, "", { ...FIRST_PARTY_COOKIE_OPTIONS, maxAge: 0 });
}

export function clearNativeSessionCookies(cookies: CookieWriter) {
  for (const name of [NATIVE_ACCESS_COOKIE, NATIVE_REFRESH_COOKIE, NATIVE_PROVIDER_COOKIE]) {
    cookies.set(name, "", { ...FIRST_PARTY_COOKIE_OPTIONS, maxAge: 0 });
  }
}

export class TransientNativeSessionRefreshError extends Error {
  readonly transient = true;
}

export function isTransientHubStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Trades a refresh token for a new session, or null when the Hub refuses it.
 * Throws TransientNativeSessionRefreshError when the Hub cannot answer now.
 */
export async function refreshNativeSession(refreshToken: string): Promise<AuthResponse | null> {
  const response = await postRefreshToken(HUB_ROUTES.refresh, refreshToken).catch((error) => {
    console.warn("[auth] native session refresh unreachable", error);
    throw new TransientNativeSessionRefreshError("Native session refresh is temporarily unavailable");
  });

  if (!response.ok) {
    if (isTransientHubStatus(response.status)) {
      throw new TransientNativeSessionRefreshError("Native session refresh is temporarily unavailable");
    }
    return null;
  }

  const payload = (await response.json().catch(() => null)) as Partial<AuthResponse> | null;
  return isCompleteAuthResponse(payload) ? payload : null;
}

/** Ends the Hub session a signed-out app held. Best effort: the cookies are cleared either way. */
export async function revokeNativeSession(refreshToken: string): Promise<void> {
  await postRefreshToken(HUB_ROUTES.sign_out, refreshToken)
    .catch((error) => console.warn("[auth] native session revoke unreachable", error));
}

function postRefreshToken(route: string, refreshToken: string): Promise<Response> {
  return fetch(withRoute(getXMatrixHubUrl(), route), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  });
}

export function isCompleteAuthResponse(payload: Partial<AuthResponse> | null): payload is AuthResponse {
  return Boolean(payload?.token && payload.refreshToken && payload.user && payload.hubUrl && payload.relayUrl);
}
