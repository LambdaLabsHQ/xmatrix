/**
 * Dispatched when the Hub refuses the session token, from a socket (4401) or
 * an HTTP 401 to a request that carried it; the auth provider renews it.
 */
export const AUTH_TOKEN_REJECTED_EVENT = "xmatrix:auth-token-rejected";

/** A 401 to a request that sent the bearer token: the token, not the request, is stale. */
export function noteRejectedToken(status: number, sentToken: boolean): void {
  if (status !== 401 || !sentToken || typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_TOKEN_REJECTED_EVENT));
}
