import { parseGooglePlaySubscriptionConfig, sha256Hex, type GooglePlaySubscriptionConfig } from "@xmatrix/protocol";
import { readStoreJson, StoreBillingError } from "../store-billing-errors";
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import type { BillingSubscriptionFact, GooglePlayEnvironment } from "@xmatrix/db";

export const GOOGLE_PLAY_PACKAGE = "sh.xmatrix.app";
export type { GooglePlaySubscriptionConfig } from "@xmatrix/protocol";
export class GooglePlayBillingError extends StoreBillingError {}

export function googlePlaySubscriptionConfig(raw: string | undefined): GooglePlaySubscriptionConfig {
  try { return parseGooglePlaySubscriptionConfig(raw); }
  catch { throw new GooglePlayBillingError("google_play_billing_unavailable", "Google Play subscriptions are not configured: GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG is missing or invalid"); }
}

const PURCHASE_TOKEN = /^[A-Za-z0-9._:-]{20,1024}$/;
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function validPurchaseToken(value: unknown): string {
  if (typeof value !== "string" || !PURCHASE_TOKEN.test(value)) throw new GooglePlayBillingError("invalid_google_play_purchase", "Invalid Google Play purchase");
  return value;
}

const boundedJson = (response: Response, signal: AbortSignal) =>
  readStoreJson(response, signal, () => new GooglePlayBillingError("google_play_response_invalid", "Google Play response is invalid", true));

/** A short-lived OAuth token for the Google Play Developer API, from the service account key. */
export async function googlePlayAccessToken(config: GooglePlaySubscriptionConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
  let assertion: string;
  try {
    const key = await importPKCS8(config.privateKey, "RS256");
    assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/androidpublisher" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(config.serviceAccountEmail).setAudience(TOKEN_URL)
      .setIssuedAt().setExpirationTime("5m").sign(key);
  } catch { throw new GooglePlayBillingError("google_play_signing_failed", "Google Play signing is temporarily unavailable", true); }
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, { method: "POST", redirect: "manual", signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  } catch { throw new GooglePlayBillingError("google_play_request_failed", "Google Play is temporarily unavailable", true); }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new GooglePlayBillingError("google_play_auth_failed", "Google refused the Play service account", response.status >= 500 || response.status === 429);
  }
  const body = await boundedJson(response, signal) as { access_token?: unknown };
  if (typeof body?.access_token !== "string" || !body.access_token) throw new GooglePlayBillingError("google_play_response_invalid", "Google returned no access token", true);
  return body.access_token;
}

export interface VerifiedGooglePlaySubscription {
  environment: GooglePlayEnvironment;
  /** SHA-256 of the purchase token: the token itself is never stored. */
  purchaseTokenDigest: string;
  accountToken: string;
  basePlanId: string;
  interval: "month" | "year";
  expiresAt: string;
  active: boolean;
  onHold: boolean;
  paused: boolean;
  pending: boolean;
  cancelAtPeriodEnd: boolean;
  needsAcknowledgement: boolean;
}

type PlaySubscriptionPurchase = {
  subscriptionState?: string;
  acknowledgementState?: string;
  testPurchase?: unknown;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: { productId?: string; expiryTime?: string; autoRenewingPlan?: { autoRenewEnabled?: boolean };
    offerDetails?: { basePlanId?: string } }[];
};

/** The verified facts of one purchase token, from Google's SubscriptionPurchaseV2. */
export async function subscriptionFact(config: GooglePlaySubscriptionConfig, purchaseToken: string,
  purchase: PlaySubscriptionPurchase, now = Date.now()): Promise<VerifiedGooglePlaySubscription> {
  const items = Array.isArray(purchase.lineItems) ? purchase.lineItems : [];
  const item = items.length === 1 ? items[0] : undefined;
  const basePlanId = item?.offerDetails?.basePlanId;
  const accountToken = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  const expires = Date.parse(item?.expiryTime ?? "");
  if (!item || item.productId !== config.subscriptionId ||
      (basePlanId !== config.monthlyBasePlanId && basePlanId !== config.annualBasePlanId) ||
      typeof accountToken !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(accountToken) ||
      typeof purchase.subscriptionState !== "string" || !purchase.subscriptionState.startsWith("SUBSCRIPTION_STATE_")) {
    throw new GooglePlayBillingError("invalid_google_play_purchase", "Google Play subscription fields are invalid");
  }
  const state = purchase.subscriptionState;
  const pending = state === "SUBSCRIPTION_STATE_PENDING";
  if (!pending && !Number.isFinite(expires)) throw new GooglePlayBillingError("invalid_google_play_purchase", "Google Play subscription has no expiry");
  // Canceled means renewal is off; the paid period still runs to its expiry.
  const paidState = ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_CANCELED"].includes(state);
  return {
    environment: purchase.testPurchase ? "Test" : "Production",
    purchaseTokenDigest: await sha256Hex(purchaseToken),
    accountToken: accountToken.toLowerCase(), basePlanId,
    interval: basePlanId === config.monthlyBasePlanId ? "month" : "year",
    expiresAt: new Date(Number.isFinite(expires) ? expires : now).toISOString(),
    active: paidState && expires > now,
    onHold: state === "SUBSCRIPTION_STATE_ON_HOLD",
    paused: state === "SUBSCRIPTION_STATE_PAUSED",
    pending,
    cancelAtPeriodEnd: state === "SUBSCRIPTION_STATE_CANCELED" || item.autoRenewingPlan?.autoRenewEnabled === false,
    needsAcknowledgement: purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && paidState,
  };
}

/** Read one purchase token afresh from Google; client and notification claims are only triggers. */
export async function retrieveGooglePlaySubscription(config: GooglePlaySubscriptionConfig, purchaseToken: unknown,
  fetchImpl: typeof fetch = fetch): Promise<VerifiedGooglePlaySubscription> {
  const token = validPurchaseToken(purchaseToken);
  const access = await googlePlayAccessToken(config, fetchImpl);
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetchImpl(`${API}/applications/${GOOGLE_PLAY_PACKAGE}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`, {
      headers: { authorization: `Bearer ${access}` }, redirect: "manual", signal });
  } catch { throw new GooglePlayBillingError("google_play_request_failed", "Google Play verification is temporarily unavailable", true); }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new GooglePlayBillingError("google_play_request_failed", "Google Play could not verify this purchase", response.status >= 500 || response.status === 429);
  }
  const body = await boundedJson(response, signal);
  if (!body || typeof body !== "object") throw new GooglePlayBillingError("google_play_response_invalid", "Invalid Google Play subscription response");
  return subscriptionFact(config, token, body as PlaySubscriptionPurchase);
}

/** Acknowledge a paid purchase; Google refunds one left unacknowledged for three days. */
export async function acknowledgeGooglePlaySubscription(config: GooglePlaySubscriptionConfig, purchaseToken: string,
  fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = validPurchaseToken(purchaseToken);
  const access = await googlePlayAccessToken(config, fetchImpl);
  let response: Response;
  try {
    response = await fetchImpl(`${API}/applications/${GOOGLE_PLAY_PACKAGE}/purchases/subscriptions/${encodeURIComponent(config.subscriptionId)}/tokens/${encodeURIComponent(token)}:acknowledge`, {
      method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: "{}",
      redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch { throw new GooglePlayBillingError("google_play_request_failed", "Google Play acknowledgement is temporarily unavailable", true); }
  void response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new GooglePlayBillingError("google_play_acknowledge_failed", "Google Play did not accept the purchase acknowledgement", true);
}

export function googlePlayBillingFact(subscription: VerifiedGooglePlaySubscription, binding: { spaceId: string; ownerUserId: string; accountDeleted?: boolean }): BillingSubscriptionFact {
  if (binding.accountDeleted) throw new GooglePlayBillingError("google_play_purchase_account_deleted", "Deleted accounts cannot receive subscription access");
  return { billingProvider: "google", id: `google:${subscription.environment}:${subscription.purchaseTokenDigest.slice(0, 40)}`,
    customerId: subscription.accountToken, priceId: subscription.basePlanId,
    status: subscription.active ? "active" : subscription.onHold ? "unpaid" : subscription.paused ? "paused"
      : subscription.pending ? "incomplete" : "canceled",
    quantity: 1, currentPeriodEnd: subscription.expiresAt, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    spaceId: binding.spaceId, billingOwnerUserId: binding.ownerUserId };
}

const GOOGLE_CERTS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/**
 * A Real-time developer notification pushed by Pub/Sub. The push carries an
 * OIDC token Google signs for the configured push service account; anything
 * else is refused. The notification only names a purchase token to re-read.
 */
export async function verifyGooglePlayPush(config: GooglePlaySubscriptionConfig, authorization: string | null, envelope: unknown,
  keys: Parameters<typeof jwtVerify>[1] = GOOGLE_CERTS): Promise<{ purchaseToken: string } | null> {
  const bearer = /^Bearer ([A-Za-z0-9._-]{1,8192})$/.exec(authorization ?? "")?.[1];
  if (!bearer) throw new GooglePlayBillingError("invalid_google_play_notification", "Google Play notification is not signed");
  try {
    const { payload } = await jwtVerify(bearer, keys as never, { issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: config.pushAudience, algorithms: ["RS256"] });
    if (payload.email !== config.pushServiceAccountEmail || payload.email_verified !== true) throw new Error();
  } catch { throw new GooglePlayBillingError("invalid_google_play_notification", "Google Play notification verification failed"); }
  const data = (envelope as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== "string" || data.length > 16_384) throw new GooglePlayBillingError("invalid_google_play_notification", "Google Play notification is invalid");
  let note: { packageName?: unknown; subscriptionNotification?: { purchaseToken?: unknown } };
  try { note = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))); }
  catch { throw new GooglePlayBillingError("invalid_google_play_notification", "Google Play notification is invalid"); }
  if (note?.packageName !== GOOGLE_PLAY_PACKAGE) throw new GooglePlayBillingError("invalid_google_play_notification", "Google Play notification names another app");
  // Test notifications and one-time product notices name no subscription.
  if (!note.subscriptionNotification) return null;
  return { purchaseToken: validPurchaseToken(note.subscriptionNotification.purchaseToken) };
}
