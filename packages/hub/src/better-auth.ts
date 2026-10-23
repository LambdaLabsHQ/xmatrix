import { betterAuth, type BetterAuthOptions } from "better-auth";
import { decodeJwt } from "jose";
import { APIError } from "better-auth/api";
import { bearer, emailOTP, jwt } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";

import {
} from "@xmatrix/protocol";

import { AUTH_POSTGRES_MODELS, AUTH_POSTGRES_PASSKEY_SCHEMA } from "./auth-postgres-models";
import {
  authAuthority,
  authPostgresTransaction,
  requireAuthD1,
  withAuthPostgresPool,
} from "./auth-authority";
import type { AuthSession, AuthUser } from "./auth";
import { resolveAuthCookieDomain, resolveAuthCookiePrefix } from "./auth-cookie-domain";
import { SESSION_EXCHANGE_USER_MISMATCH } from "./auth-errors";
import {
  normalizeBetterAuthRouteStatus,
  type AuthRouteFailureStatus,
} from "./better-auth-error-policy";
import { EmailDeliveryConfigurationError, escapeHtml, sendEmail } from "./email-delivery";
import { passwordResetEmail, VERIFIED_PASSWORD_OPTIONS } from "./auth-password-policy";
import { runBetterAuthHandlerWithObservedHookFailure } from "./better-auth-request-lifecycle";
import { mintHandleForNewAccount } from "./human-handle-mint";
import { mcpOAuthPlugins } from "./mcp-oauth";
import { TWO_FACTOR_REQUIRED, twoFactorPlugins } from "./two-factor";
import { appOrigin, appOrigins, hubAuthBaseUrl } from "./deployment-origins";
import type { Env } from "./types";

/** The iOS app's bundle id, the audience of the identity tokens its Sign in with Apple returns. */
const APPLE_APP_BUNDLE_ID = "sh.xmatrix.app";

type BetterAuthUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
};

type BetterAuthSessionResponse = {
  user?: BetterAuthUser;
  token?: string;
  twoFactorRedirect?: boolean;
};

type BetterAuthGetSessionResponse = {
  user?: BetterAuthUser;
  session?: {
    token?: string;
  };
};

type BetterAuthTokenResponse = {
  token?: string;
};

type BetterAuthUserRow = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
};

type BetterAuthHandler = {
  handler(request: Request): Response | Promise<Response>;
};

/** The Better Auth instance: its HTTP handler and the server-side calls the Hub makes. */
type BetterAuthInstance = BetterAuthHandler & {
  api: {
    getAccessToken(input: { body: { providerId: string; userId: string } }): Promise<{ accessToken?: string }>;
  };
};

type AuthDatabase = NonNullable<BetterAuthOptions["database"]>;

export interface AuthBehaviorHooks {
  mintHandleForNewAccount(userId: string): Promise<void>;
  sendLoginCode(email: string, otp: string): Promise<void>;
  sendPasswordReset(email: string, url: string): Promise<void>;
}

export class BetterAuthRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BetterAuthRequestError";
    this.status = status;
    this.code = code;
  }
}

function betterAuthRequestErrorFromUnknown(error: unknown): BetterAuthRequestError {
  if (error instanceof BetterAuthRequestError) return error;
  if (error instanceof EmailDeliveryConfigurationError) {
    return new BetterAuthRequestError(503, error.message, error.code, { cause: error });
  }
  if (error instanceof APIError) {
    const message = error.body?.message || error.message || "Better Auth request failed";
    return new BetterAuthRequestError(
      error.statusCode,
      message,
      error.body?.code,
      { cause: error },
    );
  }
  return new BetterAuthRequestError(
    503,
    "Authentication service is temporarily unavailable.",
    undefined,
    { cause: error },
  );
}

export function betterAuthRouteErrorStatus(
  error: unknown,
  invalidStatus: AuthRouteFailureStatus = 500,
): AuthRouteFailureStatus {
  if (error instanceof EmailDeliveryConfigurationError) return 503;
  return normalizeBetterAuthRouteStatus(
    error instanceof BetterAuthRequestError ? error.status : undefined,
    invalidStatus,
  );
}

export function betterAuthHandlerErrorResponse(error: unknown): Response {
  const failure = betterAuthRequestErrorFromUnknown(error);
  const status = betterAuthRouteErrorStatus(failure);
  return Response.json(
    {
      error: failure.message,
      ...(failure.code ? { code: failure.code } : {}),
    },
    { status },
  );
}

export function createAuth(env: Env): BetterAuthHandler {
  return {
    handler: (request) => handleProductAuthRequest(env, request),
  };
}

async function handleProductAuthRequest(env: Env, request: Request): Promise<Response> {
  const postgres = authAuthority(env) === "postgres";
  if (postgres) {
    return withAuthPostgresPool(env, (database) =>
      handleProductAuthRequestWithDatabase(env, request, database, true));
  }
  return handleProductAuthRequestWithDatabase(env, request, requireAuthD1(env), false);
}

async function handleProductAuthRequestWithDatabase(
  env: Env,
  request: Request,
  database: AuthDatabase,
  postgres: boolean,
): Promise<Response> {
  let emailOtpFailure: unknown;
  const auth = createAuthWithDatabase(
    env,
    database,
    postgres,
    productAuthBehavior(env),
    (error) => {
      emailOtpFailure = error;
    },
    /^\/api\/auth\/callback\/(google|github)$/u.test(new URL(request.url).pathname),
  );
  // Better Auth 1.6 catches failures raised by runInBackgroundOrAwait and
  // otherwise returns 200. Re-raise the request-local failure after its
  // handler settles so callers never observe a false successful send.
  return runBetterAuthHandlerWithObservedHookFailure(
    () => Promise.resolve(auth.handler(request)),
    () => emailOtpFailure,
  );
}

function productAuthBehavior(env: Env): AuthBehaviorHooks {
  return {
    mintHandleForNewAccount: (userId) => mintHandleForNewAccount(env, userId),
    sendLoginCode: (email, otp) => sendLoginCodeEmail(env, email, otp),
    sendPasswordReset: (email, url) => sendEmail(env, email, passwordResetEmail(url)),
  };
}

function createAuthWithDatabase(
  env: Env,
  database: AuthDatabase,
  postgres: boolean,
  behavior: AuthBehaviorHooks,
  observeEmailOtpFailure?: (error: unknown) => void,
  socialCallback = false,
): BetterAuthInstance {
  if (!env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is not configured");
  }
  const authCookieDomain = resolveAuthCookieDomain(env);
  const authCookiePrefix = resolveAuthCookiePrefix(env);

  const socialProviders: BetterAuthOptions["socialProviders"] = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      // Always ask which account, so a browser signed in to one Google
      // account can still sign in to xMatrix with another.
      prompt: "select_account",
    };
  }
  // The GitHub App's OAuth identity supports sign-in and explicit profile
  // linking. Space installations remain separate connector grants.
  if (env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      prompt: "select_account",
    };
  }

  // The iOS app's Sign in with Apple hands its identity token straight to
  // `/sign-in/social`; Apple signs it for the app's bundle id. There is no
  // web redirect flow for Apple, so no client secret is configured.
  socialProviders.apple = {
    clientId: APPLE_APP_BUNDLE_ID,
    clientSecret: "",
    appBundleIdentifier: APPLE_APP_BUNDLE_ID,
  };

  const jwtPlugin = postgresJwtPlugin(env, postgres);
  return betterAuth({
    appName: "xMatrix",
    baseURL: hubAuthBaseUrl(env),
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: Array.from(new Set([...appOrigins(env), hubAuthBaseUrl(env)])),
    socialProviders,
    // A missing/consumed state cannot supply the flow's errorCallbackURL.
    // Keep that refusal recoverable through the deployment-owned login page.
    ...(socialCallback ? { onAPIError: { errorURL: `${appOrigin(env)}/login` } } : {}),
    emailAndPassword: {
      ...VERIFIED_PASSWORD_OPTIONS,
      async sendResetPassword({ user, url }) {
        try { await behavior.sendPasswordReset(user.email, url); }
        catch (error) { observeEmailOtpFailure?.(error); throw error; }
      },
    },
    // Its limiter counts in one isolate's memory, which on Workers is no
    // limit at all; sign-in allowances are counted exactly instead
    // (request-rate-limit.ts AUTH_ROUTE_ATTEMPTS).
    rateLimit: { enabled: false },
    account: {
      ...(postgres ? AUTH_POSTGRES_MODELS.account : {}),
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        // A GitHub account is linked by its owner while signed in; its email
        // need not be the xMatrix one.
        allowDifferentEmails: true,
      },
    },
    user: {
      ...(postgres ? {
          modelName: AUTH_POSTGRES_MODELS.user.modelName,
          fields: AUTH_POSTGRES_MODELS.user.fields,
        } : {}),
      // The Human Profile lives on the existing `user` row rather than in a
      // parallel table: this is the account of record, and a second store for
      // four fields would only add a way for the two to disagree. `name` and
      // `image` keep carrying displayName and avatar.
      additionalFields: {
        handle: { type: "string", required: false, input: true },
        bio: { type: "string", required: false, input: true },
        timeZone: { type: "string", required: false, input: true },
        // Server-owned. A client that could set its own version could pin it
        // high and make every later profile edit look stale to Relay authority,
        // freezing its own name everywhere it is read.
        profileVersion: {
          type: "number", required: false, input: false,
          ...(postgres ? { fieldName: AUTH_POSTGRES_MODELS.user.additionalFields.profileVersion } : {}),
        },
        profileCompletedAt: {
          type: "date", required: false, input: false,
          ...(postgres
            ? { fieldName: AUTH_POSTGRES_MODELS.user.additionalFields.profileCompletedAt }
            : {}),
        },
      },
    },
    ...(postgres ? {
        session: AUTH_POSTGRES_MODELS.session,
        verification: AUTH_POSTGRES_MODELS.verification,
      } : {}),
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // An account with no handle has no `@` address, so minting it is
            // part of creating one. It runs after the insert rather than in
            // `before` because the candidate list is derived from the account
            // id, which does not exist yet at that point.
            //
            // Deliberately non-fatal: a person who cannot be addressed can
            // still be signed in and can still set a handle themselves, so
            // nothing here is worth failing a sign-up over. The backfill
            // sweeps up whatever this misses.
            await behavior.mintHandleForNewAccount(user.id);
          },
        },
      },
    },
    advanced: {
      trustedProxyHeaders: true,
      // Better Auth 1.6.33 stores OAuth state/PKCE for ten minutes but
      // defaults its signed state cookie to five. Keep the browser proof
      // for the same window so a slow provider login can still return.
      cookies: { state: { attributes: { maxAge: 600 } } },
      ...(authCookiePrefix ? { cookiePrefix: authCookiePrefix } : {}),
      ...(authCookieDomain
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: authCookieDomain,
            },
          }
        : {}),
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"],
      },
    },
    plugins: [
      emailOTP({
        async sendVerificationOTP({ email, otp }) {
          try {
            await behavior.sendLoginCode(email, otp);
          } catch (error) {
            observeEmailOtpFailure?.(error);
            throw error;
          }
        },
        expiresIn: 300,
        otpLength: 6,
      }),
      jwtPlugin,
      bearer(),
      ...twoFactorPlugins(env, postgres),
      // Passkeys belong to the app's own domain, so one made on xmatrix.sh
      // signs in on any of its pages, the beta Web's included; the Hub only
      // checks them.
      passkey({
        rpID: new URL(appOrigin(env)).hostname,
        rpName: "xMatrix",
        origin: appOrigins(env),
        ...(postgres ? { schema: AUTH_POSTGRES_PASSKEY_SCHEMA } : {}),
      }),
      // Outside AI apps sign in through the PostgreSQL authority only.
      ...(postgres ? mcpOAuthPlugins(env) : []),
    ],
  });
}

function postgresJwtPlugin(env: Env, postgres: boolean): ReturnType<typeof jwt> {
  const plugin = jwt({
    jwks: {
      keyPairConfig: { alg: "ES256" },
      jwksPath: "/jwks",
    },
    jwt: {
      issuer: hubAuthBaseUrl(env),
      // Keep this aligned with the CLI refresh cadence. The migration adapter
      // must preserve the D1 authority's token lifetime exactly.
      expirationTime: "1 hour",
      definePayload: ({ user, session }) => ({
        auth_session_id: session.id,
        email: user.email,
        name: user.name,
        user_metadata: {
          name: user.name,
          avatar_url: user.image,
          picture: user.image,
        },
      }),
    },
  });
  if (!postgres) return plugin;
  const fields = plugin.schema.jwks.fields;
  return {
    ...plugin,
    schema: {
      ...plugin.schema,
      jwks: {
        ...plugin.schema.jwks,
        modelName: AUTH_POSTGRES_MODELS.jwks.modelName,
        fields: {
          publicKey: {
            ...fields.publicKey,
            fieldName: AUTH_POSTGRES_MODELS.jwks.fields.publicKey,
          },
          privateKey: {
            ...fields.privateKey,
            fieldName: AUTH_POSTGRES_MODELS.jwks.fields.privateKey,
          },
          createdAt: {
            ...fields.createdAt,
            fieldName: AUTH_POSTGRES_MODELS.jwks.fields.createdAt,
          },
          expiresAt: {
            ...fields.expiresAt,
            fieldName: AUTH_POSTGRES_MODELS.jwks.fields.expiresAt,
          },
        },
      },
    },
  } as unknown as ReturnType<typeof jwt>;
}

export async function sendBetterAuthLoginOtp(env: Env, email: string): Promise<void> {
  await callBetterAuth(env, "/email-otp/send-verification-otp", {
    method: "POST",
    body: JSON.stringify({ email, type: "sign-in" }),
  });
}

export async function verifyBetterAuthEmailOtp(
  env: Env,
  email: string,
  otp: string
): Promise<AuthSession> {
  const response = await callBetterAuth(env, "/sign-in/email-otp", {
    method: "POST",
    body: JSON.stringify({ email, otp }),
  });
  const payload = (await response.json().catch(() => ({}))) as BetterAuthSessionResponse;
  // This route returns tokens and has no step for the code; the browser does.
  if (payload.twoFactorRedirect) {
    throw new BetterAuthRequestError(403,
      "Two-step verification is on for this account. Sign in in your browser.", TWO_FACTOR_REQUIRED);
  }
  if (!payload.token || !payload.user?.id || !payload.user.email) {
    throw new BetterAuthRequestError(
      503,
      "Authentication service returned an incomplete session.",
    );
  }

  const jwtToken = await createBetterAuthJwtForSession(env, payload.token);
  return {
    token: jwtToken,
    refreshToken: payload.token,
    authProvider: "better-auth",
    user: authUserFromBetterAuthUser(payload.user),
  };
}

export async function refreshBetterAuthSession(
  env: Env,
  refreshToken: string
): Promise<AuthSession> {
  const sessionResponse = await callBetterAuth(env, "/get-session", {
    headers: {
      authorization: `Bearer ${refreshToken}`,
    },
  });
  const sessionPayload = (await sessionResponse.json().catch(() => ({}))) as
    | BetterAuthGetSessionResponse
    | null;
  if (!sessionPayload?.user?.id || !sessionPayload.user.email) {
    throw new BetterAuthRequestError(401, "Invalid or expired auth token");
  }

  const sessionToken = sessionPayload.session?.token || refreshToken;
  const jwtToken = await createBetterAuthJwtForSession(env, sessionToken);
  return {
    token: jwtToken,
    refreshToken: sessionToken,
    authProvider: "better-auth",
    user: authUserFromBetterAuthUser(sessionPayload.user),
  };
}

function sessionExchangeFacts(user: AuthUser) {
  const now = new Date();
  return {
    now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    sessionToken: crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""),
    sessionId: crypto.randomUUID(),
    name: user.name || user.email,
  };
}

function exchangedSessionUser(user: AuthUser, existingUser?: BetterAuthUserRow): AuthUser {
  return existingUser
    ? {
        id: existingUser.id,
        email: existingUser.email,
        name: existingUser.name || undefined,
        avatarUrl: existingUser.image || undefined,
      }
    : user;
}

async function completeSessionExchange(
  env: Env,
  sessionToken: string,
  user: AuthUser,
): Promise<AuthSession> {
  return {
    token: await createBetterAuthJwtForSession(env, sessionToken),
    refreshToken: sessionToken,
    authProvider: "better-auth",
    user,
  };
}

/**
 * A session the Hub issues itself, for a terminal, daemon or app that proved
 * who it is. `label` names what holds it in the person's session list, where
 * a browser's own sessions show their user agent.
 */
export async function createBetterAuthSessionForUser(
  env: Env,
  user: AuthUser,
  label?: string,
): Promise<AuthSession> {
  if (authAuthority(env) === "postgres") {
    return createPostgresSessionForUser(env, user, label);
  }
  const authDatabase = requireAuthD1(env);

  const { now, expiresAt, sessionToken, sessionId, name } = sessionExchangeFacts(user);
  const existingUser = await authDatabase.prepare(
    'SELECT "id", "email", "name", "image" FROM "user" WHERE lower("email") = lower(?)'
  )
    .bind(user.email)
    .first<BetterAuthUserRow>();
  const sessionUser = exchangedSessionUser(user, existingUser ?? undefined);
  if (sessionUser.id !== user.id) {
    throw new Error(SESSION_EXCHANGE_USER_MISMATCH);
  }

  await authDatabase.batch([
    ...(!existingUser ? [authDatabase.prepare([
      'INSERT INTO "user"',
      '("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")',
      "VALUES (?, ?, ?, 1, ?, ?, ?)",
    ].join(" ")).bind(user.id, name, user.email, user.avatarUrl || null,
      now.toISOString(), now.toISOString())] : []),
    authDatabase.prepare(
      [
        'INSERT INTO "session"',
        '("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")',
        "VALUES (?, ?, ?, ?, ?, ?)",
      ].join(" ")
    ).bind(
      sessionId,
      expiresAt.toISOString(),
      sessionToken,
      now.toISOString(),
      now.toISOString(),
      sessionUser.id
    ),
  ]);

  return completeSessionExchange(env, sessionToken, sessionUser);
}

async function createPostgresSessionForUser(env: Env, user: AuthUser, label?: string): Promise<AuthSession> {
  const { now, expiresAt, sessionToken, sessionId, name } = sessionExchangeFacts(user);
  const existingUser = await authPostgresTransaction(
    env,
    "auth.session_exchange.read_user",
    async (transaction) => {
      const rows = await transaction.query<BetterAuthUserRow & { [column: string]: unknown }>({
        name: "auth_session_exchange_read_user_v1",
        text: `SELECT id, email, name, image FROM control.auth_users
          WHERE lower(email) = lower($1) LIMIT 1`,
        values: [user.email], maxRows: 1,
      });
      return rows[0];
    },
  );
  const sessionUser = exchangedSessionUser(user, existingUser);
  if (sessionUser.id !== user.id) throw new Error(SESSION_EXCHANGE_USER_MISMATCH);

  await authPostgresTransaction(env, "auth.session_exchange.write", async (transaction) => {
    // A retained token proves identity; its old profile fields must not
    // overwrite the name or avatar the person has since chosen.
    if (!existingUser) {
      await transaction.query({
        name: "auth_session_exchange_insert_user_v1",
        text: `INSERT INTO control.auth_users
          (id, name, email, email_verified, image, created_at, updated_at)
          VALUES ($1, $2, $3, true, $4, $5, $5)`,
        values: [user.id, name, user.email, user.avatarUrl || null, now], maxRows: 0,
      });
    }
    // Each exchange adds a row; the user's expired ones are dead tokens.
    await transaction.query({
      name: "auth_session_exchange_prune_expired_v1",
      text: `DELETE FROM control.auth_sessions WHERE user_id = $1 AND expires_at < $2`,
      values: [sessionUser.id, now], maxRows: 0,
    });
    await transaction.query({
      name: "auth_session_exchange_insert_session_v2",
      text: `INSERT INTO control.auth_sessions
        (id, expires_at, token, created_at, updated_at, user_id, user_agent)
        VALUES ($1, $2, $3, $4, $4, $5, $6)`,
      values: [sessionId, expiresAt, sessionToken, now, sessionUser.id, label?.slice(0, 256) ?? null], maxRows: 0,
    });
  });

  return completeSessionExchange(env, sessionToken, sessionUser);
}

/**
 * Starts a Google or GitHub sign-in whose provider answer comes back to
 * `callbackURL` on this Hub. The browser that follows `url` must also keep
 * `cookies`: they bind the provider's answer to that browser.
 */
export async function startBetterAuthSocialRedirect(env: Env, provider: "google" | "github",
  callbackURL: string, errorCallbackURL: string): Promise<{ url: string; cookies: string[] }> {
  const response = await callBetterAuth(env, "/sign-in/social", {
    method: "POST",
    body: JSON.stringify({ provider, callbackURL, errorCallbackURL, disableRedirect: true }),
  });
  const payload = (await response.json().catch(() => ({}))) as { url?: unknown };
  if (typeof payload.url !== "string" || !payload.url) {
    throw new BetterAuthRequestError(503, "Authentication service returned no provider address.");
  }
  return { url: payload.url, cookies: response.headers.getSetCookie() };
}

/** The person a browser request's own session cookie signs in, and when their account was made; null without one. */
export async function betterAuthUserFromCookies(env: Env, cookieHeader: string | null):
  Promise<{ user: AuthUser; createdAt: number | null } | null> {
  if (!cookieHeader) return null;
  const response = await callBetterAuth(env, "/get-session", { headers: { cookie: cookieHeader } });
  const payload = (await response.json().catch(() => null)) as
    (BetterAuthGetSessionResponse & { user?: { createdAt?: string } }) | null;
  if (!payload?.user?.id || !payload.user.email) return null;
  const createdAt = payload.user.createdAt ? Date.parse(payload.user.createdAt) : Number.NaN;
  return { user: authUserFromBetterAuthUser(payload.user), createdAt: Number.isNaN(createdAt) ? null : createdAt };
}

/**
 * Ends the session a refresh token names, so neither it nor an access token
 * minted from it is accepted again. Ending a session that is already gone is
 * not an error: signing out twice signs out once.
 */
export async function revokeBetterAuthSession(env: Env, sessionToken: string): Promise<void> {
  if (authAuthority(env) === "postgres") {
    await authPostgresTransaction(env, "auth.session_revoke", async (transaction) => {
      await transaction.query({
        name: "auth_session_revoke_v1",
        text: "DELETE FROM control.auth_sessions WHERE token = $1",
        values: [sessionToken], maxRows: 0,
      });
    });
    return;
  }
  await requireAuthD1(env).prepare('DELETE FROM "session" WHERE "token" = ?').bind(sessionToken).run();
}

/**
 * Whether the session an already-verified access token was minted from still
 * exists. Access tokens are checked by signature alone for their hour, so a
 * route that turns one into a new session asks this first: a signed-out
 * session's leftover token must not become a fresh one. A token minted from
 * no session (an Agent Run's, a test's) has nothing to check.
 */
export async function accessTokenSessionAlive(env: Env, verifiedToken: string): Promise<boolean> {
  let sessionId: unknown;
  try {
    sessionId = decodeJwt(verifiedToken).auth_session_id;
  } catch {
    return true;
  }
  if (typeof sessionId !== "string" || !sessionId) return true;
  if (authAuthority(env) === "postgres") {
    const rows = await authPostgresTransaction(env, "auth.session_alive", async (transaction) =>
      transaction.query<{ id: string }>({
        name: "auth_session_alive_v1",
        text: "SELECT id FROM control.auth_sessions WHERE id = $1 AND expires_at > now() LIMIT 1",
        values: [sessionId], maxRows: 1,
      }));
    return rows.length > 0;
  }
  const row = await requireAuthD1(env).prepare('SELECT "id" FROM "session" WHERE "id" = ? AND "expiresAt" > ?')
    .bind(sessionId, new Date().toISOString()).first();
  return Boolean(row);
}

async function createBetterAuthJwtForSession(env: Env, sessionToken: string): Promise<string> {
  const response = await callBetterAuth(env, "/token", {
    headers: {
      authorization: `Bearer ${sessionToken}`,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as BetterAuthTokenResponse;
  if (!payload.token) {
    throw new BetterAuthRequestError(
      503,
      "Authentication service returned an incomplete token.",
    );
  }
  return payload.token;
}

async function callBetterAuth(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  let response: Response;
  try {
    response = await createAuth(env).handler(
      new Request(`${hubAuthBaseUrl(env)}/api/auth${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...init.headers,
        },
      })
    );
  } catch (error) {
    // Preserve the concrete configuration error for the product login route,
    // which already exposes its stable public error code.
    if (error instanceof EmailDeliveryConfigurationError) throw error;
    throw betterAuthRequestErrorFromUnknown(error);
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      code?: string;
    };
    const message = response.status >= 500
      ? "Authentication service is temporarily unavailable."
      : payload.message || payload.error || "Better Auth request failed";
    throw new BetterAuthRequestError(response.status, message, payload.code);
  }

  return response;
}

function authUserFromBetterAuthUser(user: BetterAuthUser): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name || undefined,
    avatarUrl: user.image || undefined,
  };
}

function buildLoginCodeEmail(email: string, code: string) {
  const safeEmail = escapeHtml(email);
  const safeCode = escapeHtml(code);
  const subject = "Your xMatrix sign-in code";
  const text = [
    "Use this code to sign in to xMatrix:",
    "",
    code,
    "",
    "This code expires soon. If you did not request it, you can ignore this email.",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172033;">
    <div style="display:none;max-height:0;overflow:hidden;">Your xMatrix sign-in code is ${safeCode}.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 18px;border-bottom:1px solid #eef0f3;">
                <div style="font-size:15px;font-weight:700;color:#111827;">xMatrix</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#111827;">Sign in to xMatrix</h1>
                <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#344054;">Use this code for ${safeEmail}:</p>
                <div style="display:inline-block;letter-spacing:6px;font-size:30px;line-height:1;font-weight:700;color:#111827;background:#f2f4f7;border:1px solid #e4e7ec;border-radius:10px;padding:16px 18px;">${safeCode}</div>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#667085;">This code expires soon. If you did not request it, you can ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

async function sendLoginCodeEmail(env: Env, email: string, code: string) {
  await sendEmail(env, email, buildLoginCodeEmail(email, code));
}
