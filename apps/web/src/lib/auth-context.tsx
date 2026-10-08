"use client";

import { AUTH_TOKEN_REJECTED_EVENT } from "@/lib/auth-events";
import { subscribeResume } from "@/lib/connectivity/connectivity";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { WEB_PROXY_ROUTES, type AuthResponse, type AuthUser } from "@xmatrix/protocol";
import {
  loadBetterAuthSession,
  isTransientAuthSessionError,
  sendBetterAuthOtp,
  signInWithBetterAuthGoogle,
  signOutBetterAuth,
  verifyBetterAuthOtp,
  type WebAuthSession,
} from "./auth-client";
import {
  isTransientNetworkSessionError,
  isTransientAuthStatus,
  shouldApplySessionRead,
  shouldRefreshAuthSessionState,
} from "./auth-session-policy";
import { getDesktopBridge } from "./desktop/bridge";
import { XMatrixQueryProvider } from "./query/query-provider";
import { xmatrixRawResponse } from "@/lib/query/api-client";

export { AUTH_TOKEN_REJECTED_EVENT };

export type { AuthUser };

interface AuthState {
  session: WebAuthSession | null;
  user: AuthUser | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  signInWithOtp: (email: string) => Promise<void>;
  verifyOtp: (email: string, token: string) => Promise<void>;
  signInWithGoogle: (redirectTo?: string) => Promise<void>;
  setSessionFromAuthResponse: (payload: AuthResponse) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Set by a browser test before any app code runs, to opt that page out of the
 * mock session the e2e server is built with.
 *
 * The signed-out screens — /login above all — are otherwise untestable in that
 * suite: the mock session sends any visitor straight to /app, so a spec that
 * asserts against the login form is really racing a redirect, and passes or
 * fails on machine speed.
 *
 * Suppressing a mock session can only ever make the app *less* authenticated,
 * and `getMockAuthState` already returns null unless the build carries the
 * mock env var, which a production build never does. So this flag grants
 * nothing to anybody.
 */
const DISABLE_MOCK_AUTH_FLAG = "__xmatrixDisableMockAuth";

function getMockAuthState(): AuthState | null {
  const token = process.env.NEXT_PUBLIC_XMATRIX_MOCK_AUTH_TOKEN?.trim();
  if (!token) {
    return null;
  }
  if (
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>)[DISABLE_MOCK_AUTH_FLAG]
  ) {
    return null;
  }

  const user: AuthUser = {
    id: process.env.NEXT_PUBLIC_XMATRIX_MOCK_AUTH_USER_ID?.trim() || "mock-user",
    email: process.env.NEXT_PUBLIC_XMATRIX_MOCK_AUTH_EMAIL?.trim() || "mock@xmatrix.local",
    name: process.env.NEXT_PUBLIC_XMATRIX_MOCK_AUTH_NAME?.trim() || "Mock User",
    avatarUrl: process.env.NEXT_PUBLIC_XMATRIX_MOCK_AUTH_AVATAR_URL?.trim() || undefined,
  };

  const session = {
    access_token: token,
    refresh_token: "mock-refresh-token",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: {
      id: user.id,
      email: user.email,
      user_metadata: { name: user.name },
      app_metadata: {},
      aud: "authenticated",
      created_at: new Date(0).toISOString(),
    },
  } as WebAuthSession;

  return { session, user, loading: false };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    session: null,
    user: null,
    loading: true,
  });
  const router = useRouter();
  const mockAuthState = useMemo(() => getMockAuthState(), []);
  const stateRef = useRef(state);
  const sessionLoadInFlightRef = useRef<Promise<Omit<AuthState, "loading">> | null>(null);

  const loadSessionStateOnce = useCallback(async (): Promise<Omit<AuthState, "loading">> => {
    if (sessionLoadInFlightRef.current) {
      return sessionLoadInFlightRef.current;
    }

    const request = loadSessionState();
    sessionLoadInFlightRef.current = request;
    try {
      return await request;
    } finally {
      if (sessionLoadInFlightRef.current === request) {
        sessionLoadInFlightRef.current = null;
      }
    }
  }, []);

  const applySessionState = useCallback((next: Omit<AuthState, "loading">) => {
    setState((prev) => {
      const candidate = { ...next, loading: false };
      return authStatesEqual(prev, candidate) ? prev : candidate;
    });
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (mockAuthState) {
      setState(mockAuthState);
      return;
    }

    let cancelled = false;
    loadSessionStateOnce()
      .then((next) => {
        if (cancelled) return;
        applySessionState(next);
      })
      .catch((error) => {
        if (cancelled) return;
        if (isTransientSessionLoadError(error)) {
          setState((prev) => ({ ...prev, loading: true }));
          return;
        }
        setState({ session: null, user: null, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [applySessionState, loadSessionStateOnce, mockAuthState]);

  useEffect(() => {
    if (mockAuthState) {
      return;
    }

    let cancelled = false;
    let transientRetries = 0;
    let transientRetryTimer: number | undefined;

    async function refreshSessionState() {
      try {
        const next = await loadSessionStateOnce();
        if (cancelled) return;
        if (
          !shouldApplySessionRead({
            currentSession: stateRef.current.session,
            nextSession: next.session,
          })
        ) {
          return;
        }
        transientRetries = 0;
        applySessionState(next);
      } catch (error) {
        if (cancelled) return;
        if (isTransientSessionLoadError(error)) {
          setState((prev) => (prev.session ? { ...prev, loading: false } : { ...prev, loading: true }));
          // Without a session the app waits on this read, so it keeps
          // trying, backing off, rather than spin until the next focus.
          if (!stateRef.current.session) {
            transientRetries += 1;
            if (transientRetryTimer !== undefined) window.clearTimeout(transientRetryTimer);
            transientRetryTimer = window.setTimeout(() => {
              if (!cancelled) void refreshSessionState();
            }, Math.min(30_000, 1_500 * 2 ** (transientRetries - 1)));
          }
          return;
        }
        setState((prev) => ({ ...prev, loading: false }));
      }
    }

    function refreshWhenVisible() {
      if (document.hidden) return;
      if (!shouldRefreshAuthSessionState(stateRef.current)) return;
      void refreshSessionState();
    }

    /* The Hub refused the current token: renew it now, visible or not. Many
       requests can be refused at once; one renewal answers all of them. */
    let lastRejectionRefresh = -Infinity;
    function refreshAfterRejection() {
      const now = Date.now();
      if (now - lastRejectionRefresh < 10_000) return;
      lastRejectionRefresh = now;
      void refreshSessionState();
    }

    refreshWhenVisible();
    const stopResume = subscribeResume((signal) => {
      // The network is back: a pending backoff would only keep the spinner up.
      if (signal.online) transientRetries = 0;
      refreshWhenVisible();
    });
    window.addEventListener(AUTH_TOKEN_REJECTED_EVENT, refreshAfterRejection);
    const interval = window.setInterval(refreshWhenVisible, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      if (transientRetryTimer !== undefined) window.clearTimeout(transientRetryTimer);
      window.removeEventListener(AUTH_TOKEN_REJECTED_EVENT, refreshAfterRejection);
      stopResume();
      window.clearInterval(interval);
    };
  }, [applySessionState, loadSessionStateOnce, mockAuthState]);

  const signInWithOtp = async (email: string) => {
    await sendBetterAuthOtp(email);
  };

  const setSessionFromAuthResponse = async (payload: AuthResponse) => {
    if (!payload.refreshToken) {
      throw new Error("Login response did not include a refresh token");
    }

    await persistNativeSession(payload);
    setState({
      session: authResponseToWebSession(payload),
      user: payload.user,
      loading: false,
    });
  };

  const verifyOtp = async (email: string, token: string) => {
    await verifyBetterAuthOtp(email, token);
    const next = await loadBetterAuthSessionAfterSignIn();
    if (next.session && next.user) {
      setState({ ...next, loading: false });
    } else {
      setState((prev) => ({ ...prev, loading: false }));
    }
  };

  const signInWithGoogle = async (redirectTo?: string) => {
    if (!isBetterAuthGoogleEnabled()) {
      throw new Error("Google sign-in is not configured for this account. Use a login code while setup is completed.");
    }
    await signInWithBetterAuthGoogle(buildBetterAuthCallbackUrl(redirectTo));
  };

  const logout = async () => {
    if (mockAuthState) {
      setState(mockAuthState || { session: null, user: null, loading: false });
      router.push("/login");
      return;
    }

    setState((prev) => ({ ...prev, loading: true }));
    await Promise.allSettled([clearNativeSession(), signOutBetterAuth()]);
    setState({ session: null, user: null, loading: false });
    router.push("/login");
  };

  return (
    <AuthContext.Provider
      value={{
        ...state,
        signInWithOtp,
        verifyOtp,
        signInWithGoogle,
        setSessionFromAuthResponse,
        logout,
      }}
    >
      <XMatrixQueryProvider userId={state.user?.id ?? null}>
        {children}
      </XMatrixQueryProvider>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
}

async function loadSessionState(): Promise<Omit<AuthState, "loading">> {
  let transientError: unknown;
  const nativeState = await loadNativeSessionState().catch((error) => {
    if (isTransientSessionLoadError(error)) {
      transientError = error;
      return null;
    }
    throw error;
  });
  if (nativeState?.session && nativeState.user) {
    return nativeState;
  }

  const betterAuthState = await loadBetterAuthSession().catch((error) => {
    if (isTransientSessionLoadError(error)) {
      transientError = error;
      return null;
    }
    throw error;
  });
  if (betterAuthState?.session && betterAuthState.user) {
    return betterAuthState;
  }

  if (transientError) throw transientError;
  return { session: null, user: null };
}

function authStatesEqual(left: AuthState, right: AuthState): boolean {
  return (
    left.loading === right.loading &&
    left.user?.id === right.user?.id &&
    left.user?.email === right.user?.email &&
    left.user?.name === right.user?.name &&
    left.user?.avatarUrl === right.user?.avatarUrl &&
    left.session?.access_token === right.session?.access_token &&
    left.session?.refresh_token === right.session?.refresh_token &&
    left.session?.expires_at === right.session?.expires_at &&
    left.session?.token_type === right.session?.token_type &&
    left.session?.user.id === right.session?.user.id &&
    left.session?.user.email === right.session?.user.email
  );
}

async function persistNativeSession(payload: AuthResponse): Promise<void> {
  if (!isNativeShell()) {
    return;
  }

  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.native_session, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => null);

  if (!response?.ok) {
    return;
  }
}

async function clearNativeSession(): Promise<void> {
  if (!isNativeShell()) {
    return;
  }

  await xmatrixRawResponse(WEB_PROXY_ROUTES.native_session, {
    method: "DELETE",
  }).catch(() => null);
}

async function loadNativeSessionState(): Promise<Omit<AuthState, "loading">> {
  if (!isNativeShell()) {
    return { session: null, user: null };
  }

  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.native_session, {
    cache: "no-store",
  }).catch((error) => {
    if (isTransientNetworkSessionError(error)) {
      throw new Error("Native app session is temporarily unavailable");
    }
    throw error;
  });

  if (!response.ok) {
    if (isTransientAuthStatus(response.status)) {
      throw new Error("Native app session is temporarily unavailable");
    }
    throw new Error("Failed to load native app session");
  }

  const payload = (await response.json().catch(() => ({}))) as { session?: AuthResponse | null };
  if (!payload.session?.token || !payload.session.user) {
    return { session: null, user: null };
  }

  return {
    session: authResponseToWebSession(payload.session),
    user: payload.session.user,
  };
}

function authResponseToWebSession(payload: AuthResponse): WebAuthSession {
  return {
    access_token: payload.token,
    refresh_token: payload.refreshToken,
    token_type: "bearer",
    user: {
      id: payload.user.id,
      email: payload.user.email,
      user_metadata: {
        name: payload.user.name,
        avatarUrl: payload.user.avatarUrl,
        avatar_url: payload.user.avatarUrl,
        picture: payload.user.avatarUrl,
      },
    },
  };
}

function isNativeShell(): boolean {
  return Boolean(getDesktopBridge());
}

function isTransientSessionLoadError(error: unknown): boolean {
  if (isTransientAuthSessionError(error)) return true;
  return isTransientNetworkSessionError(error);
}

const OAUTH_CALLBACK_PARAMS = ["code", "error", "error_code", "error_description", "state", "auth_error"];

function buildBetterAuthCallbackUrl(returnTo?: string): string {
  return new URL(normalizeOAuthReturnPath(returnTo), window.location.origin).toString();
}

function normalizeOAuthReturnPath(returnTo?: string): string {
  if (!returnTo) {
    return "/app";
  }

  try {
    const url = new URL(returnTo, window.location.origin);
    if (url.origin !== window.location.origin) {
      return "/app";
    }

    for (const param of OAUTH_CALLBACK_PARAMS) {
      url.searchParams.delete(param);
    }

    const path = `${url.pathname}${url.search}${url.hash}`;
    if (!path.startsWith("/") || path.startsWith("//")) {
      return "/app";
    }

    return path;
  } catch {
    return "/app";
  }
}

function isBetterAuthGoogleEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BETTER_AUTH_GOOGLE_ENABLED?.trim() === "true";
}

async function loadBetterAuthSessionAfterSignIn(): Promise<{
  session: WebAuthSession | null;
  user: AuthUser | null;
}> {
  const startedAt = Date.now();
  const timeoutMs = 30_000;
  let delayMs = 0;
  let lastError: Error | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    if (delayMs > 0) {
      await delay(delayMs);
    }

    try {
      const next = await loadBetterAuthSession();
      if (next.session && next.user) {
        return next;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    delayMs = Math.min(delayMs === 0 ? 250 : delayMs * 1.5, 2_000);
  }

  const error = new Error(
    "Sign-in succeeded, but the session is still not ready. Please wait a moment and try again."
  ) as Error & { cause?: Error };
  if (lastError) {
    error.cause = lastError;
  }
  throw error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
