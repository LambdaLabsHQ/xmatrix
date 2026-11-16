import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { reportError } from "@xmatrix/protocol/error-reporting";

const COOKIE_RESULTS = ["missing", "invalid", "different", "matching", "unavailable"] as const;
type CookieResult = typeof COOKIE_RESULTS[number];

/** One instance per HTTP request; never retain state, cookie values or caller identities. */
export function oauthStateDiagnostic(): { plugin: BetterAuthPlugin; logger: NonNullable<BetterAuthOptions["logger"]> } {
  let evidence: Record<string, string> | undefined;
  return {
    plugin: {
      id: "xmatrix-oauth-state-diagnostic",
      hooks: { before: [{
        matcher: ctx => ctx.path === "/callback/:id" &&
          (ctx.params?.id === "google" || ctx.params?.id === "github"),
        handler: createAuthMiddleware(async ctx => {
          const state = ctx.query?.state;
          let cookie: CookieResult = "unavailable";
          try {
            // Use the authentication library's own configured name and verifier.
            const name = ctx.context.createAuthCookie("state").name;
            if (!ctx.getCookie(name)) cookie = "missing";
            else {
              const signed = await ctx.getSignedCookie(name, ctx.context.secret);
              cookie = !signed ? "invalid" : signed === state ? "matching" : "different";
            }
          } catch { /* Optional evidence must never change authentication. */ }
          evidence = {
            oauth_provider: ctx.params?.id === "github" ? "github" : "google",
            oauth_state_cookie: cookie,
            oauth_state_present: String(Boolean(state)),
            oauth_code_present: String(Boolean(ctx.query?.code)),
            oauth_error_present: String(Boolean(ctx.query?.error)),
          };
        }),
      }] },
    },
    logger: { log(level, message, ...args: unknown[]) {
      const error = args.find((arg): arg is Error => arg instanceof Error);
      if (level === "error" && message === "Failed to parse state" && evidence &&
          error?.message === "State mismatch: State not persisted correctly") {
        // Preserve the original exception, with one report rather than a second console capture.
        reportError(error, { operation: "auth.oauth-state", ids: evidence });
        console.warn("OAuth browser state rejected", evidence);
        return;
      }
      if (level === "error") console.error(message, ...args);
      else if (level === "warn") console.warn(message, ...args);
      else console.log(message, ...args);
    } },
  };
}

/** The connector accepts only this fixed diagnostic, never arbitrary OAuth context. */
export function oauthStateMetadata(extra: Record<string, unknown>): string[] {
  const { oauth_provider: provider, oauth_state_cookie: cookie, oauth_state_present: state,
    oauth_code_present: code, oauth_error_present: error } = extra;
  if (provider !== "google" && provider !== "github" || !COOKIE_RESULTS.some(value => value === cookie) ||
      ![state, code, error].every(value => value === "true" || value === "false")) return [];
  return [`OAuth browser state: ${provider} · cookie=${cookie} · state=${state} · code=${code} · error=${error}`];
}
