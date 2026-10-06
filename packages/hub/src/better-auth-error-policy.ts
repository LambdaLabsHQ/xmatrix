export type AuthRouteFailureStatus = 400 | 401 | 403 | 408 | 429 | 500 | 503;

export function normalizeBetterAuthRouteStatus(
  status: number | undefined,
  fallback: AuthRouteFailureStatus = 500,
): AuthRouteFailureStatus {
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429
  ) {
    return status;
  }
  if (status !== undefined && status >= 500) return 503;
  return fallback;
}

export function isTransientBetterAuthStatus(status: AuthRouteFailureStatus): boolean {
  return status === 408 || status === 429 || status >= 500;
}
