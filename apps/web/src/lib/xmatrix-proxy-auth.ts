import { decodeUnverifiedJwtClaims } from "./jwt-claims";

export function resolveProxyAuthorization(input: {
  requestAuthorization?: string;
  cookieAuthorization?: string;
  nowSeconds?: number;
}): string | undefined {
  const requestAuthorization = input.requestAuthorization?.trim();
  const cookieAuthorization = input.cookieAuthorization?.trim();
  if (requestAuthorization) {
    // A suspended tab can submit its one-hour JWT before React's focus refresh
    // finishes. The server already owns a refreshable HttpOnly session, but it
    // may replace the stale header only when both JWTs name the same subject;
    // an explicit token must never be silently switched to another account.
    if (
      cookieAuthorization &&
      requestAuthorizationNeedsRefresh(requestAuthorization, input.nowSeconds) &&
      authorizationSubjectsMatch(requestAuthorization, cookieAuthorization)
    ) {
      return cookieAuthorization;
    }
    return requestAuthorization;
  }
  return cookieAuthorization || undefined;
}

export function requestAuthorizationNeedsRefresh(
  authorization: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
  refreshMarginSeconds = 5 * 60
): boolean {
  const payload = authorizationJwtPayload(authorization);
  return typeof payload?.exp === "number" && payload.exp - nowSeconds < refreshMarginSeconds;
}

function authorizationSubjectsMatch(left: string, right: string): boolean {
  const leftSubject = authorizationJwtPayload(left)?.sub;
  const rightSubject = authorizationJwtPayload(right)?.sub;
  return typeof leftSubject === "string" && leftSubject.length > 0 && leftSubject === rightSubject;
}

function authorizationJwtPayload(
  authorization: string | undefined
): { exp?: unknown; sub?: unknown } | null {
  const match = authorization?.trim().match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ? decodeUnverifiedJwtClaims(match[1]) : null;
}
