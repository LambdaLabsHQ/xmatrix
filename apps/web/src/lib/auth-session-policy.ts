import { decodeUnverifiedJwtClaims } from "./jwt-claims";

export const AUTH_SESSION_REFRESH_MARGIN_SECONDS = 5 * 60;

export interface RefreshableAuthSession {
  access_token?: string;
  expires_at?: number;
}

export interface RefreshableAuthState {
  session: RefreshableAuthSession | null;
  user: unknown | null;
  loading: boolean;
}

export function isTransientAuthStatus(status: number | undefined): boolean {
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

export function shouldRefreshAuthSessionState(
  state: RefreshableAuthState,
  nowSeconds = Math.floor(Date.now() / 1000),
  refreshMarginSeconds = AUTH_SESSION_REFRESH_MARGIN_SECONDS
): boolean {
  if (state.loading) return true;
  if (!state.session || !state.user) return true;
  if (!state.session.access_token?.trim()) return true;

  const expiresAt = jwtExpiresAtSeconds(state.session.access_token) ?? state.session.expires_at;
  if (!expiresAt) return false;
  return expiresAt - nowSeconds < refreshMarginSeconds;
}

export function jwtExpiresAtSeconds(token: string): number | undefined {
  const expiresAt = decodeUnverifiedJwtClaims(token)?.exp;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt)
    ? expiresAt
    : undefined;
}

/**
 * Chromium reports a dead connection as `TypeError: Failed to fetch`.
 * Safari uses `Load failed`. Firefox uses `NetworkError when attempting to
 * fetch resource`. None of those are logout.
 */
export function isTransientNetworkSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("load failed") ||
    message.includes("networkerror") ||
    message.includes("network request failed") ||
    message.includes("temporarily unavailable")
  );
}

/**
 * A later empty session read is not logout. Wake, missing cookies, and a
 * native-session blip must keep the live in-memory session until a successful
 * authenticated read replaces it or the user signs out.
 */
export function shouldApplySessionRead(input: {
  currentSession: unknown;
  nextSession: unknown;
}): boolean {
  if (input.currentSession && !input.nextSession) return false;
  return true;
}
