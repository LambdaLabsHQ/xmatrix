import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";

import { APP_SIGN_IN_FINISH_PATH } from "@xmatrix/protocol";
import { appOrigin, hubAuthBaseUrl } from "./deployment-origins";
import type { Env } from "./types";

/**
 * Optional two-step verification (an authenticator app, with backup codes).
 * Recommended in Settings, never required.
 *
 * Better Auth's plugin holds back only a password sign-in. Every sign-in here
 * that starts from a first factor waits for the second one: an email code, a
 * password, or Google. Sessions derived from a signed-in one (refresh, CLI
 * device approval, session exchange, MCP consent) inherit the check.
 */
export const TWO_FACTOR_REQUIRED = "two_factor_required";

const POSTGRES_SCHEMA = {
  user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
  twoFactor: {
    modelName: "control.auth_two_factors",
    fields: {
      backupCodes: "backup_codes",
      userId: "user_id",
      failedVerificationCount: "failed_verification_count",
      lockedUntil: "locked_until",
    },
  },
};

/**
 * A first factor that signs in at once. `/sign-in/social` does so only with an
 * identity token (the iOS app's Sign in with Apple); its redirect form makes
 * no session, so the check passes it by.
 */
function isFirstFactorSignIn(path: string | undefined): boolean {
  return path === "/sign-in/email" || path === "/sign-in/email-otp" || path === "/sign-in/social"
    || isSocialCallback(path);
}

function isSocialCallback(path: string | undefined): boolean {
  return Boolean(path?.startsWith("/callback/"));
}

/** Where the provider callback was about to send the browser, per request. */
const callbackDestinations = new WeakMap<object, string>();

function locationOf(returned: unknown): string | undefined {
  const headers = (returned as { headers?: unknown } | undefined)?.headers;
  return headers instanceof Headers ? headers.get("location") ?? undefined : undefined;
}

/**
 * The login page that asks for the code. A sign-in started from the login page
 * (a device or CLI approval) returns to it with its own parameters; any other
 * destination is kept as `next`.
 */
export function secondFactorPage(env: Env, destination: string | undefined): string {
  const origin = appOrigin(env);
  const page = new URL("/login", origin);
  const target = destination ? new URL(destination, origin) : null;
  if (target?.origin === origin && target.pathname === "/login") {
    target.searchParams.set("two_factor", "1");
    return target.toString();
  }
  page.searchParams.set("two_factor", "1");
  if (target?.origin === origin) page.searchParams.set("next", `${target.pathname}${target.search}`);
  // An app's sign-in finishes on this Hub, which hands the app its code once the second factor is in.
  if (target && isAppSignInFinish(env, target)) page.searchParams.set("continue", target.toString());
  return page.toString();
}

function isAppSignInFinish(env: Env, target: URL): boolean {
  return target.origin === new URL(hubAuthBaseUrl(env)).origin && target.pathname === APP_SIGN_IN_FINISH_PATH;
}

export function twoFactorPlugins(env: Env, postgres: boolean): BetterAuthPlugin[] {
  const plugin = twoFactor({
    issuer: "xMatrix",
    // Most accounts have no password: the signed-in session is what turns it on.
    allowPasswordless: true,
    ...(postgres ? { schema: POSTGRES_SCHEMA } : {}),
  }) as unknown as BetterAuthPlugin;
  const challenge = plugin.hooks!.after![0]!;

  const rememberCallbackDestination: BetterAuthPlugin = {
    id: "xmatrix-two-factor-callback-destination",
    hooks: {
      after: [{
        matcher: (ctx) => isSocialCallback(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          const location = locationOf(ctx.context.returned);
          if (location) callbackDestinations.set(ctx.context, location);
        }),
      }],
    },
  };

  /** A provider callback is a browser navigation: it answers with the code page, not JSON. */
  const redirectCallbackChallenge: BetterAuthPlugin = {
    id: "xmatrix-two-factor-callback-redirect",
    hooks: {
      after: [{
        matcher: (ctx) => isSocialCallback(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          const returned = ctx.context.returned as { twoFactorRedirect?: unknown } | undefined;
          if (!returned || typeof returned !== "object" || returned.twoFactorRedirect !== true) return;
          throw ctx.redirect(secondFactorPage(env, callbackDestinations.get(ctx.context)));
        }),
      }],
    },
  };

  return [
    rememberCallbackDestination,
    { ...plugin, hooks: { after: [{ matcher: (ctx) => isFirstFactorSignIn(ctx.path), handler: challenge.handler }] } },
    redirectCallbackChallenge,
  ];
}
