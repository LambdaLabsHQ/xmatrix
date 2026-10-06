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

export function setNativeSessionCookies(cookies: CookieWriter, payload: AuthResponse) {
  cookies.set(NATIVE_ACCESS_COOKIE, payload.token, FIRST_PARTY_COOKIE_OPTIONS);
  cookies.set(NATIVE_REFRESH_COOKIE, payload.refreshToken || "", FIRST_PARTY_COOKIE_OPTIONS);
  cookies.set(NATIVE_PROVIDER_COOKIE, payload.authProvider || "", FIRST_PARTY_COOKIE_OPTIONS);
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
  const response = await fetch(withRoute(getXMatrixHubUrl(), HUB_ROUTES.refresh), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
  }).catch((error) => {
    throw new TransientNativeSessionRefreshError(
      error instanceof Error ? error.message : "Native session refresh is temporarily unavailable"
    );
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

export function isCompleteAuthResponse(payload: Partial<AuthResponse> | null): payload is AuthResponse {
  return Boolean(payload?.token && payload.refreshToken && payload.user && payload.hubUrl && payload.relayUrl);
}
