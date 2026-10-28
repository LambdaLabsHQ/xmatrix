import type { Env } from "../types";
import { ProviderRequestError, providerJson } from "./http";

/** A Stripe App account id. The OAuth grant and the webhook `account` field use the same form. */
export const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,64}$/u;
const STRIPE_CLIENT_ID = /^ca_[A-Za-z0-9]+$/u;
const STRIPE_SECRET_KEY = /^sk_(?:live|test)_[A-Za-z0-9]+$/u;
const STRIPE_SIGNING_SECRET = /^whsec_[A-Za-z0-9]+$/u;
/** Provider-generated External test install path. It is not the public Marketplace URL. */
const EXTERNAL_AUTHORIZE_PATH = /^\/oauth\/v2\/chnlink_[A-Za-z0-9]+\/authorize$/u;
const STANDARD_AUTHORIZE_URL = "https://marketplace.stripe.com/oauth/v2/authorize";

function stripeEnv(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

/** The company app can sign connects and webhooks. A partial trio stays off. */
export function stripeAppSecretsReady(env: Env): boolean {
  return STRIPE_CLIENT_ID.test(stripeEnv(env, "CONNECTOR_STRIPE_CLIENT_ID")) &&
    STRIPE_SECRET_KEY.test(stripeEnv(env, "CONNECTOR_STRIPE_CLIENT_SECRET")) &&
    STRIPE_SIGNING_SECRET.test(stripeEnv(env, "CONNECTOR_STRIPE_SIGNING_SECRET"));
}

/**
 * Who may see Connect with Stripe. `marketplace` is every Space, on the public
 * authorize URL, and only after App review. Until then the External test path
 * and one acceptance Space must both be set, and only that Space is offered
 * the button. Anything incomplete offers it to nobody.
 */
export function stripeConnectOffered(env: Env, spaceId: string | undefined): boolean {
  if (!stripeAppSecretsReady(env)) return false;
  if (stripeEnv(env, "CONNECTOR_STRIPE_OAUTH_PUBLIC") === "marketplace") return true;
  const path = stripeEnv(env, "CONNECTOR_STRIPE_EXTERNAL_AUTHORIZE_PATH");
  const acceptance = stripeEnv(env, "CONNECTOR_STRIPE_ACCEPTANCE_SPACE_ID");
  return EXTERNAL_AUTHORIZE_PATH.test(path) && acceptance.length > 0 && acceptance.length <= 180 && spaceId === acceptance;
}

/** The authorize URL for a Space that is allowed to connect, with no query. */
export function stripeAuthorizeEndpoint(env: Env, spaceId: string): string | undefined {
  if (!stripeConnectOffered(env, spaceId)) return undefined;
  if (stripeEnv(env, "CONNECTOR_STRIPE_OAUTH_PUBLIC") === "marketplace") return STANDARD_AUTHORIZE_URL;
  return `https://marketplace.stripe.com${stripeEnv(env, "CONNECTOR_STRIPE_EXTERNAL_AUTHORIZE_PATH")}`;
}

/** Rejects any authorize URL other than Marketplace's standard or External test path. */
export function allowedStripeAuthorizeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://marketplace.stripe.com" && url.search === "" && url.hash === "" &&
      (url.pathname === "/oauth/v2/authorize" || EXTERNAL_AUTHORIZE_PATH.test(url.pathname));
  } catch {
    return false;
  }
}

/**
 * Confirms a Stripe App token response and returns its account id.
 * Access tokens last an hour; a missing `expires_in` is that hour. Stripe
 * rotates the refresh token on every exchange, so a response without one is
 * not a grant we can keep. Provider error text is never returned.
 */
export function validateStripeGrant(payload: Record<string, unknown>, expectedAccount?: string): string {
  const account = payload.stripe_user_id;
  const seconds = payload.expires_in === undefined ? 3_600 : Number(payload.expires_in);
  const refresh = payload.refresh_token;
  if (typeof payload.access_token !== "string" || !payload.access_token || payload.access_token.length > 4_096 ||
      typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer" ||
      typeof refresh !== "string" || !refresh || refresh.length > 4_096 || refresh === payload.access_token ||
      typeof account !== "string" || !STRIPE_ACCOUNT_ID.test(account) ||
      (expectedAccount !== undefined && account !== expectedAccount) ||
      payload.scope !== "stripe_apps" || typeof payload.livemode !== "boolean" ||
      !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 7_200) {
    throw new ProviderRequestError(502, "Stripe did not confirm an expiring Stripe App grant; reconnect");
  }
  payload.expires_in = seconds;
  return account;
}

/** Check reads the connected account and requires it to be the granted one. A pasted webhook secret has no token to check. */
export async function verifyStripe(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.oauthToken) return;
  if (!STRIPE_ACCOUNT_ID.test(credentials.stripeUserId ?? "")) {
    throw new ProviderRequestError(401, "Stripe OAuth requires a complete expiring grant; reconnect");
  }
  const account = await providerJson("https://api.stripe.com/v1/account", {
    headers: { authorization: `Basic ${btoa(`${credentials.oauthToken}:`)}` },
    describeError: () => "Stripe refused the connected account",
  });
  if (account.id !== credentials.stripeUserId) {
    throw new ProviderRequestError(502, "Stripe account does not match this connection");
  }
}
