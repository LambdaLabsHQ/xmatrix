"use client";

import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import type { AuthUser } from "@/lib/auth-context";
import { classifyAuthClientFailure } from "@/lib/auth-error-policy";
import { isTransientAuthStatus } from "@/lib/auth-session-policy";
import { xmatrixRawResponse } from "@/lib/query/api-client";
import { UserFacingProblem } from "@/lib/user-facing-error";

const AUTH_UNAVAILABLE = "The sign-in service can't be reached right now. Check your connection and try again.";

export interface WebAuthSession {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type: "bearer";
  user: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
}

/** Sign-in could not be checked; the session stands until it can be. */
export class TransientAuthSessionError extends UserFacingProblem {
  readonly transient = true;

  constructor() {
    super(AUTH_UNAVAILABLE, true);
    this.name = "TransientAuthSessionError";
  }
}

/** A sign-in refusal; Better Auth and the Hub's sign-in routes word these for people. */
class AuthClientError extends UserFacingProblem {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = "AuthClientError";
    this.code = code;
    this.status = status;
  }
}

const authClient = createAuthClient({
  baseURL: getAuthBaseUrl(),
  plugins: [emailOTPClient()],
});

function getAuthBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_AUTH_BASE_URL?.trim().replace(/\/+$/, "") ||
    process.env.NEXT_PUBLIC_XMATRIX_HUB_URL?.trim().replace(/\/+$/, "") ||
    "https://xmatrix-hub.xmatrix.sh"
  );
}

export async function loadBetterAuthSession(): Promise<{
  session: WebAuthSession | null;
  user: AuthUser | null;
}> {
  const sessionResponse = await authClient.getSession().catch((error) => {
    console.warn("[auth] sign-in service unreachable", error);
    throw new TransientAuthSessionError();
  });
  if (sessionResponse.error) {
    if (isTransientAuthStatus(sessionResponse.error.status)) {
      throw new TransientAuthSessionError();
    }
    throw new AuthClientError(
      sessionResponse.error.message || "Failed to load Better Auth session",
      sessionResponse.error.code,
      sessionResponse.error.status,
    );
  }

  const data = sessionResponse.data as
    | {
        user?: {
          id?: string;
          email?: string;
          name?: string | null;
          image?: string | null;
        };
        session?: {
          token?: string;
          expiresAt?: string | Date;
        };
      }
    | null
    | undefined;

  if (!data?.user?.id || !data.user.email) {
    return { session: null, user: null };
  }

  const token = await fetchBetterAuthJwt();
  if (!token) {
    return { session: null, user: null };
  }

  const user: AuthUser = {
    id: data.user.id,
    email: data.user.email,
    name: data.user.name || undefined,
    avatarUrl: data.user.image || undefined,
  };

  return {
    user,
    session: {
      access_token: token,
      refresh_token: data.session?.token,
      expires_at: expiresAtSeconds(data.session?.expiresAt),
      token_type: "bearer",
      user: {
        id: user.id,
        email: user.email,
        user_metadata: {
          name: user.name,
          avatarUrl: user.avatarUrl,
          avatar_url: user.avatarUrl,
          picture: user.avatarUrl,
        },
      },
    },
  };
}

/** Raise a Better Auth failure, separating infrastructure failures from rejections. */
function throwAuthClientError(
  error: { code?: string; message?: string; status?: number },
  fallbackMessage: string,
  status = error.status,
): never {
  const message = error.message || "";
  const failure = classifyAuthClientFailure({
    status,
    emailConfiguration: error.code === "email_delivery_configuration_error",
  });
  if (failure === "transient") {
    throw new TransientAuthSessionError();
  }
  throw new AuthClientError(message || fallbackMessage, error.code, status);
}

/**
 * Request a login code through the Hub rather than calling Better Auth from the
 * browser.
 *
 * Better Auth runs its `sendVerificationOTP` hook inside a wrapper that
 * swallows thrown errors, so a refusal raised there would reach the browser as
 * a success with no mail behind it; the Hub route reports delivery failures.
 */
export async function sendBetterAuthOtp(email: string): Promise<void> {
  await postAuthRequest(WEB_PROXY_ROUTES.login, { email }, "Failed to send login code");
}

/** POST to a Hub proxy route, raising the Hub's own reason for a refusal. */
async function postAuthRequest(
  route: string,
  body: Record<string, string>,
  fallbackMessage: string
): Promise<void> {
  const response = await xmatrixRawResponse(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  }).catch((error) => {
    console.warn("[auth] sign-in service unreachable", error);
    throw new TransientAuthSessionError();
  });
  if (response.ok) return;

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  throwAuthClientError(
    { message: payload.error, code: payload.code, status: response.status },
    fallbackMessage,
    response.status,
  );
}

export async function verifyBetterAuthOtp(email: string, otp: string): Promise<void> {
  const response = await authClient.signIn.emailOtp({
    email,
    otp,
  }).catch((error) => {
    console.warn("[auth] sign-in service unreachable", error);
    throw new TransientAuthSessionError();
  });
  if (response.error) {
    throwAuthClientError(response.error, "Invalid verification code", response.error.status);
  }
}

export async function signInWithBetterAuthGoogle(callbackURL: string): Promise<void> {
  const response = await authClient.signIn.social({
    provider: "google",
    callbackURL,
    // Without this, a failed sign-in redirects to the Hub's own error URL and
    // the person is left on a JSON document with no way back.
    errorCallbackURL: `${window.location.origin}/login`,
  });
  if (response.error) {
    throw new AuthClientError(response.error.message || "Google sign-in failed", response.error.code, response.error.status);
  }
}

export async function verifyBetterAuthPassword(email: string, password: string): Promise<void> {
  const response = await authClient.signIn.email({ email, password }).catch(() => {
    throw new TransientAuthSessionError();
  });
  if (response.error) throwAuthClientError(response.error, "Couldn't sign in");
}

export async function requestAccountPassword(email: string): Promise<void> {
  const response = await authClient.requestPasswordReset({
    email, redirectTo: `${window.location.origin}/reset-password`,
  }).catch(() => { throw new TransientAuthSessionError(); });
  if (response.error) throwAuthClientError(response.error, "Couldn't send password email");
}

export async function resetAccountPassword(token: string, newPassword: string): Promise<void> {
  const response = await authClient.resetPassword({ token, newPassword })
    .catch(() => { throw new TransientAuthSessionError(); });
  if (response.error) throwAuthClientError(response.error, "Couldn't set password");
}

/** The GitHub account this person linked, by GitHub's user id; null when none. */
export async function linkedGitHubAccount(): Promise<{ accountId: string } | null> {
  const response = await authClient.listAccounts();
  if (response.error) throw new AuthClientError(response.error.message || "Could not read linked accounts", response.error.code, response.error.status);
  const account = (response.data ?? []).find((item) => item.providerId === "github");
  return account ? { accountId: account.accountId } : null;
}

/** Proves which GitHub account is this person's, through GitHub's own sign-in. */
export async function linkGitHubAccount(callbackURL: string): Promise<void> {
  const response = await authClient.linkSocial({ provider: "github", callbackURL, errorCallbackURL: callbackURL });
  if (response.error) throw new AuthClientError(response.error.message || "Could not link GitHub", response.error.code, response.error.status);
}

export async function unlinkGitHubAccount(accountId: string): Promise<void> {
  const response = await authClient.unlinkAccount({ providerId: "github", accountId });
  if (response.error) throw new AuthClientError(response.error.message || "Could not unlink GitHub", response.error.code, response.error.status);
}

export async function signOutBetterAuth(): Promise<void> {
  const response = await authClient.signOut();
  if (response.error) {
    throw new AuthClientError(response.error.message || "Failed to sign out", response.error.code, response.error.status);
  }
}

async function fetchBetterAuthJwt(): Promise<string | null> {
  const response = await xmatrixRawResponse(`${getAuthBaseUrl()}/api/auth/token`, {
    credentials: "include",
    cache: "no-store",
  }).catch((error) => {
    console.warn("[auth] sign-in service unreachable", error);
    throw new TransientAuthSessionError();
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return null;
    }
    if (isTransientAuthStatus(response.status)) {
      throw new TransientAuthSessionError();
    }
    throw new Error("Failed to fetch Better Auth token");
  }
  const payload = (await response.json().catch(() => ({}))) as { token?: string };
  const token = payload.token?.trim();
  if (!token) {
    throw new Error("Better Auth token response was incomplete");
  }
  return token;
}

function expiresAtSeconds(value: string | Date | undefined): number | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor(date.getTime() / 1000);
}

export function isTransientAuthSessionError(error: unknown): boolean {
  return error instanceof TransientAuthSessionError;
}
