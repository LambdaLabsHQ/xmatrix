import type { Context, Hono } from "hono";
import { deriveHumanConnectionUrl, HUB_ROUTES } from "@xmatrix/protocol";
import {
  APP_SIGN_IN_PROVIDERS,
  appSignInCallback,
  appSignInRedirectUri,
  isAppSignInState,
  isPkceChallenge,
  type AppSignInProvider,
} from "./app-sign-in";
import { betterAuthUserFromCookies, startBetterAuthSocialRedirect } from "./better-auth";
import { escapeHtml } from "./email-delivery";
import { hubAuthBaseUrl } from "./deployment-origins";
import { logAuthMetric } from "./auth-observability";
import { getDeviceAuthBroker, hubOrigin, internalClientHeaders, requestFailure } from "./index-shared";
import { failureResponse } from "./error-contract";
import type { Env } from "./types";

/**
 * An app signs in at Google or GitHub in the system's sign-in sheet or browser
 * (app-sign-in.ts): `start` opens the provider, `finish` is where the provider
 * comes back to, and `token` is where the app redeems what `finish` handed it.
 */
export function registerAppSignInRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get(HUB_ROUTES.app_sign_in_start, async (c) => {
    const provider = c.req.query("provider");
    const redirectUri = appSignInRedirectUri(c.req.query("redirect_uri"));
    const challenge = c.req.query("code_challenge");
    const state = c.req.query("state");
    if (!APP_SIGN_IN_PROVIDERS.includes(provider as AppSignInProvider) || !redirectUri
      || c.req.query("code_challenge_method") !== "S256" || !isPkceChallenge(challenge) || !isAppSignInState(state)) {
      return endedPage(c, 400, "This sign-in link isn't valid. Go back to xMatrix and start again.");
    }
    const flowId = await brokerJson<{ flowId: string }>(c, "start", { challenge, redirectUri, state });
    if (!flowId) return endedPage(c, 503, "xMatrix couldn't start the sign-in. Go back and try again.");
    const finish = new URL(HUB_ROUTES.app_sign_in_finish, hubAuthBaseUrl(c.env));
    finish.searchParams.set("flow", flowId.flowId);
    const failed = new URL(finish);
    failed.searchParams.set("failed", "1");
    try {
      const { url, cookies } = await startBetterAuthSocialRedirect(c.env, provider as AppSignInProvider,
        finish.toString(), failed.toString());
      await logAuthMetric({ routeGroup: "app_sign_in_start", status: 302, outcome: provider as string });
      const headers = new Headers({ location: url, "cache-control": "no-store" });
      for (const cookie of cookies) headers.append("set-cookie", cookie);
      return new Response(null, { status: 302, headers });
    } catch (error) {
      console.error("App sign-in could not reach the provider", { error: (error as Error).message });
      return endedPage(c, 503, "xMatrix couldn't open the sign-in page. Go back and try again.");
    }
  });

  app.get(HUB_ROUTES.app_sign_in_finish, async (c) => {
    const flowId = c.req.query("flow") ?? "";
    const refused = c.req.query("failed") === "1" || Boolean(c.req.query("error"));
    let user = null;
    if (!refused) {
      try {
        user = await betterAuthUserFromCookies(c.env, c.req.header("cookie") ?? null);
      } catch (error) {
        console.error("App sign-in could not read the provider's session", { error: (error as Error).message });
      }
    }
    const answer = await brokerJson<{ redirectUri: string; state: string; code?: string }>(c, "answer",
      { flowId, ...(user ? { user } : {}) });
    if (!answer) return endedPage(c, 410, "This sign-in has ended. Go back to xMatrix and start again.");
    const error = answer.code ? undefined : c.req.query("error") || (refused ? "access_denied" : "no_session");
    await logAuthMetric({ routeGroup: "app_sign_in_finish", status: 302, outcome: error ?? "signed_in",
      ...(user ? { userId: user.id } : {}) });
    return c.redirect(appSignInCallback(answer.redirectUri, answer.state,
      answer.code ? { code: answer.code } : { error: error ?? "no_session" }), 302);
  });

  app.post(HUB_ROUTES.app_sign_in_token, async (c) => {
    const response = await getDeviceAuthBroker(c.env).fetch(new Request(
      new URL("/internal/app-sign-in/redeem", c.req.url).toString(),
      { method: "POST", headers: internalClientHeaders(c.req.raw), body: await c.req.text() },
    )).catch((error: unknown) => error);
    if (!(response instanceof Response)) return failureResponse(requestFailure(response));
    if (!response.ok) return new Response(response.body, { status: response.status, headers: response.headers });
    const session = await response.json() as Record<string, unknown>;
    return c.json({ ...session, hubUrl: hubOrigin(c.req.raw), relayUrl: deriveHumanConnectionUrl(c.req.url) },
      200, { "cache-control": "no-store" });
  });
}

async function brokerJson<T>(c: Context<{ Bindings: Env }>, action: "start" | "answer", body: object): Promise<T | null> {
  const response = await getDeviceAuthBroker(c.env).fetch(new Request(
    new URL(`/internal/app-sign-in/${action}`, c.req.url).toString(),
    { method: "POST", headers: internalClientHeaders(c.req.raw), body: JSON.stringify(body) },
  ));
  return response.ok ? await response.json() as T : null;
}

/** What the sign-in sheet shows when there is no app to go back to with an answer. */
function endedPage(c: Context<{ Bindings: Env }>, status: 400 | 410 | 503, text: string): Response {
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>xMatrix sign-in</title></head>
<body style="font-family:system-ui,sans-serif;background:#f5efe5;color:#2a1c10;padding:40px 24px;max-width:28rem;margin:auto">
<h1 style="font-size:1.25rem">Sign-in didn't finish</h1><p>${escapeHtml(text)}</p></body></html>`, status,
  { "cache-control": "no-store" });
}
