"use client";

import { AUTH_TOKEN_REJECTED_EVENT } from "@/lib/auth-events";
import { withCurrentSignupSource } from "@/lib/signup-source";
import { subscribeResume } from "@/lib/connectivity/connectivity";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { WEB_PROXY_ROUTES, isPlaceholderHumanName, type AuthResponse, type AuthUser } from "@xmatrix/protocol";
import {
  loadBetterAuthSession,
  isTransientAuthSessionError,
  sendBetterAuthOtp,
  routeAccountCallsThroughApp,
  signInWithAppleIdToken,
  signInWithBetterAuthPasskey,
  signInWithBetterAuthSocial,
  SESSION_READ_TIMEOUT_MS,
  signOutBetterAuth,
  verifyBetterAuthOtpWithRetry,
  verifyBetterAuthPassword,
  verifyBetterAuthSecondFactor,
  type SignInStep,
  type SocialSignInProvider,
  type WebAuthSession,
} from "./auth-client";
import { rememberAppSignOut } from "./app-sign-in";
import { sessionNotReadyMessage, type SessionNotReadyGap } from "./session-not-ready";
import { sameValue } from "./same-value";
import {
  isTransientNetworkSessionError,
  isTransientAuthStatus,
  shouldApplySessionRead,
  shouldRefreshAuthSessionState,
} from "./auth-session-policy";
import { getDesktopBridge } from "./desktop/bridge";
import { handDesktopSessionToCli } from "./desktop/session-exchange";
import { disableBrowserPush, forgetPhonePush, registerPhonePush } from "./push-subscription";
import { XMatrixQueryProvider } from "./query/query-provider";
import { clearPersistedChannelComposerDrafts } from "@/components/dashboard/channel-composer-drafts";
import { xmatrixApiRequest, xmatrixRawResponse } from "@/lib/query/api-client";
import {
  announceEmbedAccount,
  announceEmbedSignOut,
  extensionEmbedParent,
  requestEmbedSession,
  subscribeEmbedSignOut,
} from "./extension-embed";

export { AUTH_TOKEN_REJECTED_EVENT };

export type { AuthUser };

interface AuthState {
  session: WebAuthSession | null;
  user: AuthUser | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  signInWithOtp: (email: string) => Promise<void>;
  verifyOtp: (email: string, token: string) => Promise<SignInStep>;
  signInWithPassword: (email: string, password: string) => Promise<SignInStep>;
  /** Finishes a sign-in that waits on the authenticator app's code. */
  verifySecondFactor: (code: string, options: { backup: boolean; trustDevice: boolean }) => Promise<void>;
  /** `returnTo` is where a completed sign-in goes; a failed one comes back to the page it started on. */
  signInWithSocial: (provider: SocialSignInProvider, returnTo?: string) => Promise<void>;
  /** Signs in with a passkey; `autoFill` waits for the browser to offer one in the email field. */
  signInWithPasskey: (autoFill?: boolean) => Promise<void>;
  /** Signs in with the identity token the iOS app's Sign in with Apple returned. */
  signInWithApple: (input: Parameters<typeof signInWithAppleIdToken>[0]) => Promise<SignInStep>;
  setSessionFromAuthResponse: (payload: AuthResponse) => Promise<void>;
  /** `redirectTo` may carry the sign-in page's own query, to sign in again to the same request. */
  logout: (options?: { redirectTo?: LogoutDestination }) => Promise<void>;
}

type LogoutDestination = "/account/delete" | "/login" | `/login?${string}`;

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
      return sameValue(prev, candidate) ? prev : candidate;
    });
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // In a phone app, register push on sign-in and quietly check native store review eligibility after settling.
  const signedInUserId = state.user?.id;
  useEffect(() => {
    const accessToken = stateRef.current.session?.access_token;
    if (mockAuthState || !signedInUserId || !accessToken) return;
    void registerPhonePush(accessToken).catch(() => undefined);
    const reviewTimer = window.setTimeout(() => {
      void getDesktopBridge()?.requestStoreReview?.().catch(() => undefined);
    }, 5_000);
    return () => window.clearTimeout(reviewTimer);
  }, [mockAuthState, signedInUserId]);

  // In the extension's side panel, signing out there signs this frame out too.
  useEffect(() => {
    const parent = extensionEmbedParent();
    if (mockAuthState || !parent) return;
    return subscribeEmbedSignOut(parent, () => setState({ session: null, user: null, loading: false }));
  }, [mockAuthState]);

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
        // The side panel opened with the account its extension remembered: read it from the Hub behind the open app.
        if (!next.session || !embedAccountRemembered) return;
        void loadSessionStateOnce().then((confirmed) => {
          if (!cancelled && confirmed.session) applySessionState(confirmed);
        }).catch(() => undefined);
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

    await handDesktopSessionToCli(getDesktopBridge(), payload.token);
    await persistNativeSession(payload);
    setState({
      session: authResponseToWebSession(payload),
      user: payload.user,
      loading: false,
    });
  };

  const verifyOtp = async (email: string, token: string) => {
    if (await verifyBetterAuthOtpWithRetry(email, token) === "two_factor") return "two_factor";
    const next = await loadBetterAuthSessionAfterSignIn();
    if (next.session && next.user) {
      await handDesktopSessionToCli(getDesktopBridge(), next.session.access_token);
      setState({ ...next, loading: false });
    } else {
      setState((prev) => ({ ...prev, loading: false }));
    }
    return "signed_in";
  };

  /** The session a first or second factor just made, taken up here; a desktop app hands it to its CLI too. */
  const adoptSignedInSession = async () => {
    const next = await loadBetterAuthSessionAfterSignIn();
    if (!next.session || !next.user) throw new Error("Couldn't confirm sign-in. Try again.");
    await handDesktopSessionToCli(getDesktopBridge(), next.session.access_token);
    setState({ ...next, loading: false });
  };

  const verifySecondFactor = async (code: string, options: { backup: boolean; trustDevice: boolean }) => {
    await verifyBetterAuthSecondFactor(code, options);
    await adoptSignedInSession();
  };

  const signInWithPasskey = async (autoFill = false) => {
    await signInWithBetterAuthPasskey(autoFill);
    await adoptSignedInSession();
  };

  const signInWithApple = async (input: Parameters<typeof signInWithAppleIdToken>[0]) => {
    if (await signInWithAppleIdToken(input) === "two_factor") return "two_factor";
    await adoptSignedInSession();
    return "signed_in";
  };

  const signInWithSocial = async (provider: SocialSignInProvider, returnTo?: string) => {
    if (provider === "google" && !isBetterAuthGoogleEnabled()) {
      throw new Error("Google sign-in is not configured for this account. Use a login code while setup is completed.");
    }
    const callbackURL = buildBetterAuthCallbackUrl(returnTo);
    await signInWithBetterAuthSocial(provider, callbackURL, buildBetterAuthCallbackUrl(window.location.href),
      newAccountCallbackUrl(callbackURL));
  };

  const signInWithPassword = async (email: string, password: string) => {
    if (await verifyBetterAuthPassword(email, password) === "two_factor") return "two_factor";
    await adoptSignedInSession();
    return "signed_in";
  };

  const logout = async (options?: { redirectTo?: LogoutDestination }) => {
    const destination = logoutDestination(options?.redirectTo);
    // Recorded first: the person is leaving this account, whatever the sign-out below answers.
    rememberAppSignOut();
    clearPersistedChannelComposerDrafts(state.user?.id);
    if (mockAuthState) {
      setState(mockAuthState || { session: null, user: null, loading: false });
      router.push(destination);
      return;
    }

    // In the extension's side panel the session is the extension's: it ends it there.
    const embedParent = extensionEmbedParent();
    if (embedParent) {
      announceEmbedSignOut(embedParent);
      setState({ session: null, user: null, loading: false });
      return;
    }

    setState((prev) => ({ ...prev, loading: true }));
    // A signed-out browser is told nothing: forget its push subscription while the session can still say so.
    const accessToken = state.session?.access_token;
    if (accessToken) {
      await Promise.allSettled([disableBrowserPush(accessToken), forgetPhonePush(accessToken)]);
    }
    // The session ends at the Hub while this app still holds its token; only then is the token forgotten.
    await signOutBetterAuth().catch(() => undefined);
    await clearNativeSession();
    setState({ session: null, user: null, loading: false });
    router.push(destination);
  };

  return (
    <AuthContext.Provider
      value={{
        ...state,
        signInWithOtp,
        verifyOtp,
        signInWithPassword,
        verifySecondFactor,
        signInWithSocial,
        signInWithApple,
        signInWithPasskey,
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

/** The signed-in reader's bearer token, or null where no one is signed in or nothing provides the session. */
/**
 * A session another part of xMatrix already holds, handed to a surface that
 * cannot sign in by itself: the extension's question box on a web page, which
 * reads its token from the extension. Read-only: nothing here signs in or out.
 */
export function GrantedAuthProvider({ token, user, children }: { token: string; user: AuthUser; children: ReactNode }) {
  const value = useMemo<AuthContextValue>(() => {
    const refuse = () => Promise.reject(new Error("Sign in from the xMatrix side panel."));
    return {
      session: { access_token: token, token_type: "bearer", user: { id: user.id, email: user.email } },
      user, loading: false,
      signInWithOtp: refuse, verifyOtp: refuse, signInWithPassword: refuse, verifySecondFactor: refuse,
      signInWithSocial: refuse, signInWithPasskey: refuse, signInWithApple: refuse,
      setSessionFromAuthResponse: refuse, logout: refuse,
    };
  }, [token, user]);
  return (
    <AuthContext.Provider value={value}>
      <XMatrixQueryProvider userId={user.id}>{children}</XMatrixQueryProvider>
    </AuthContext.Provider>
  );
}

export function useAuthToken(): string | null {
  return useContext(AuthContext)?.session?.access_token ?? null;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }

  return context;
}

async function loadSessionState(): Promise<Omit<AuthState, "loading">> {
  const embedParent = extensionEmbedParent();
  if (embedParent) return loadEmbedSessionState(embedParent);
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

/**
 * The side panel's session: a current access token from the extension, asked
 * for on every load and renewal (the extension renews it), and the account it
 * belongs to. Nothing is stored here.
 *
 * The extension remembers the account, so the first load opens the app with it
 * at once instead of waiting on a read of it; the provider then loads once
 * more behind the open app. That load, and every later one, reads the account
 * from the Hub, which is what tells a session the Hub ended from one that is
 * merely slow.
 */
let embedAccountRemembered = false;
let embedAccountAsked = false;
async function loadEmbedSessionState(parent: string): Promise<Omit<AuthState, "loading">> {
  let embed = await requestEmbedSession(parent);
  if (!embed) return { session: null, user: null };
  // An account still under the name the Hub made up for it may have been named since: only the Hub knows.
  let user = embedAccountAsked || !embed.user || isPlaceholderHumanName(embed.user.name, embed.user.id)
    ? undefined : embed.user;
  embedAccountAsked = true;
  embedAccountRemembered = Boolean(user);
  if (!user) {
    const readAccount = async (token: string) =>
      (await xmatrixApiRequest<{ user: AuthUser }>({ url: WEB_PROXY_ROUTES.me, token })).user;
    try {
      user = await readAccount(embed.token);
      // The token itself names the account: one issued before the account was named still says the made-up
      // name. A renewed token says the name it has now.
      if (isPlaceholderHumanName(user.name, user.id)) {
        const renewed = await requestEmbedSession(parent, { renew: true });
        if (renewed && renewed.token !== embed.token) {
          embed = renewed;
          user = await readAccount(embed.token);
        }
      }
    } catch (error) {
      // The Hub refused the extension's session: it signs in again in the panel.
      if (isRejectedTokenError(error)) {
        announceEmbedSignOut(parent);
        return { session: null, user: null };
      }
      throw error;
    }
    // What the extension opens the app with next time.
    announceEmbedAccount(parent, user);
  }
  return {
    session: {
      access_token: embed.token,
      token_type: "bearer",
      user: { id: user.id, email: user.email, user_metadata: { name: user.name, avatarUrl: user.avatarUrl,
        avatar_url: user.avatarUrl, picture: user.avatarUrl } },
    },
    user,
  };
}

/**
 * Keeps a native app's session for its next launch. A sign-in that could not
 * be kept is reported, rather than looking done until the app is reopened.
 */
async function persistNativeSession(payload: AuthResponse): Promise<void> {
  if (!isNativeShell()) {
    return;
  }
  routeAccountCallsThroughApp(true);

  for (const waitMs of [0, 700, 1500]) {
    if (waitMs) await delay(waitMs);
    const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.native_session, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    if (response?.ok) return;
  }
  throw new Error("Signed in, but this app couldn't keep the session. Try again.");
}

async function clearNativeSession(): Promise<void> {
  if (!isNativeShell()) {
    return;
  }
  routeAccountCallsThroughApp(false);

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
    signal: AbortSignal.timeout(SESSION_READ_TIMEOUT_MS),
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
    routeAccountCallsThroughApp(false);
    return { session: null, user: null };
  }

  routeAccountCallsThroughApp(true);
  return {
    session: authResponseToWebSession(payload.session),
    user: payload.session.user,
  };
}

function logoutDestination(requested: LogoutDestination | undefined): LogoutDestination {
  if (requested === "/account/delete") return requested;
  // Only the sign-in page's own query comes back; anything else lands on the plain page.
  return requested?.startsWith("/login?") && !requested.includes("//") ? requested : "/login";
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

function isRejectedTokenError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
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

    // Only login pages carry this provider's callback artifacts. An outside
    // app's authorization return has its own state, which must survive.
    if (url.pathname === "/login" || url.pathname === "/login/password") {
      for (const param of OAUTH_CALLBACK_PARAMS) {
        url.searchParams.delete(param);
      }
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

/**
 * Where a sign-in that made a new account lands: the same place in the app,
 * flagged so the app says so. Anywhere else keeps its own flow.
 */
function newAccountCallbackUrl(callbackURL: string): string {
  const url = new URL(callbackURL);
  // Only the app itself says so; an outside app's authorization query must stay as it was signed.
  if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return callbackURL;
  url.searchParams.set("new_account", "1");
  // The new account's first page tells the Hub where the visit came from.
  return withCurrentSignupSource(url.toString());
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
  let attempts = 0;
  let gap: SessionNotReadyGap = "empty_user";
  let errorName: string | undefined;
  let lastError: Error | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    if (delayMs > 0) {
      await delay(delayMs);
    }

    attempts += 1;
    try {
      const next = await loadBetterAuthSession();
      if (next.session && next.user) {
        return next;
      }
      gap = next.gap ?? "empty_user";
      errorName = undefined;
      lastError = null;
    } catch (error) {
      gap = "error";
      errorName = error instanceof Error ? error.name : "unknown";
      lastError = error instanceof Error ? error : null;
    }

    delayMs = Math.min(delayMs === 0 ? 250 : delayMs * 1.5, 2_000);
  }

  const error = new Error(sessionNotReadyMessage(gap, attempts, errorName)) as Error & { cause?: Error };
  if (lastError) {
    error.cause = lastError;
  }
  throw error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
