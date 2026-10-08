import { parseAppleSubscriptionConfig, type AppleSubscriptionConfig } from "@xmatrix/protocol";
import { Buffer } from "node:buffer";
import type { JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import { importPKCS8, SignJWT } from "jose";
import type { BillingSubscriptionFact } from "@xmatrix/db";
import { APPLE_ROOT_G3 } from "./root-certificate";

export const APPLE_BUNDLE_ID = "sh.xmatrix.app";
export type AppleEnvironment = "Production" | "Sandbox";
export type { AppleSubscriptionConfig } from "@xmatrix/protocol";
export class AppleBillingError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}

export function appleSubscriptionConfig(raw: string | undefined): AppleSubscriptionConfig {
  try { return parseAppleSubscriptionConfig(raw); }
  catch { throw new AppleBillingError("apple_billing_unavailable", "App Store subscriptions are not configured"); }
}

async function verifier(config: AppleSubscriptionConfig, environment: AppleEnvironment) {
  // Load inside the request: the SDK initializes its random source on import.
  const { Environment, SignedDataVerifier } = await import("@apple/app-store-server-library");
  // Incoming messages are only triggers; entitlement facts are always fetched
  // afresh from Apple's authenticated API below. Offline certificate validation
  // avoids SDK OCSP networking outside our bounded fetch policy.
  return new SignedDataVerifier([Buffer.from(APPLE_ROOT_G3, "base64")], false,
    environment === "Production" ? Environment.PRODUCTION : Environment.SANDBOX, APPLE_BUNDLE_ID, config.appAppleId);
}

function environment(value: unknown): AppleEnvironment {
  if (value !== "Production" && value !== "Sandbox") throw new AppleBillingError("invalid_apple_environment", "Invalid Apple environment");
  return value;
}

export async function verifyAppleNotification(config: AppleSubscriptionConfig, signedPayload: unknown) {
  if (typeof signedPayload !== "string" || signedPayload.length > 64_000) throw new AppleBillingError("invalid_apple_notification", "Invalid Apple notification");
  for (const realm of ["Production", "Sandbox"] as const) {
    try {
      const check = await verifier(config, realm);
      const note = await check.verifyAndDecodeNotification(signedPayload);
      if (!note.data?.signedTransactionInfo) return null;
      const transaction = await check.verifyAndDecodeTransaction(note.data.signedTransactionInfo);
      if (!transaction.originalTransactionId || !transaction.appAccountToken) return null;
      return { transactionId: transaction.originalTransactionId, appAccountToken: transaction.appAccountToken, environment: realm };
    } catch { /* A fixed second environment is allowed, never Xcode/local testing. */ }
  }
  throw new AppleBillingError("invalid_apple_notification", "Apple notification verification failed");
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppleBillingError("apple_response_invalid", "Apple response is invalid", true);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1_048_576) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new AppleBillingError("apple_response_invalid", "Apple response is invalid", true); }
  finally { reader.releaseLock(); }
}

export interface VerifiedAppleSubscription {
  environment: AppleEnvironment;
  originalTransactionId: string;
  appAccountToken: string;
  productId: string;
  transactionId: string;
  expiresAt: string;
  signedAt: string;
  active: boolean;
  retrying: boolean;
  cancelAtPeriodEnd: boolean;
}

export async function retrieveAppleSubscription(config: AppleSubscriptionConfig, transactionId: unknown,
  realmValue: unknown, fetchImpl: typeof fetch = fetch): Promise<VerifiedAppleSubscription> {
  const realm = environment(realmValue);
  if (typeof transactionId !== "string" || !/^[0-9]{1,100}$/.test(transactionId)) throw new AppleBillingError("invalid_apple_transaction", "Invalid Apple transaction");
  const host = realm === "Production" ? "https://api.storekit.apple.com" : "https://api.storekit-sandbox.apple.com";
  let response: Response;
  try {
    const key = await importPKCS8(config.privateKey, "ES256");
    const token = await new SignJWT({ bid: APPLE_BUNDLE_ID }).setProtectedHeader({ alg: "ES256", kid: config.keyId, typ: "JWT" })
      .setIssuer(config.issuerId).setAudience("appstoreconnect-v1").setIssuedAt().setExpirationTime("5m").sign(key);
    response = await fetchImpl(`${host}/inApps/v1/subscriptions/${transactionId}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new AppleBillingError("apple_request_failed", "Apple subscription verification is temporarily unavailable", true); }
  if (!response.ok) { await response.body?.cancel(); throw new AppleBillingError("apple_request_failed", "Apple subscription could not be verified", response.status >= 500 || response.status === 429); }
  const body = await boundedJson(response);
  if (!body || typeof body !== "object") throw new AppleBillingError("apple_response_invalid", "Invalid Apple subscription response");
  const data = body as { bundleId?: string; environment?: string; data?: { lastTransactions?: { status?: number; signedTransactionInfo?: string; signedRenewalInfo?: string }[] }[] };
  if (data.bundleId !== APPLE_BUNDLE_ID || data.environment !== realm || !Array.isArray(data.data) || data.data.length > 20) throw new AppleBillingError("apple_response_invalid", "Invalid Apple subscription response");
  const records = data.data.flatMap((group) => group.lastTransactions ?? []);
  if (records.length > 20) throw new AppleBillingError("apple_response_invalid", "Apple subscription response is too large");
  const check = await verifier(config, realm);
  const matches: VerifiedAppleSubscription[] = [];
  try {
    for (const record of records) {
      if (!record.signedTransactionInfo || !record.signedRenewalInfo) continue;
      const transaction = await check.verifyAndDecodeTransaction(record.signedTransactionInfo);
      const renewal = await check.verifyAndDecodeRenewalInfo(record.signedRenewalInfo);
      if (renewal.originalTransactionId !== transaction.originalTransactionId) throw new Error();
      if (transaction.originalTransactionId !== transactionId) continue;
      matches.push(subscriptionFact(config, realm, record.status, transaction, renewal));
    }
  } catch { throw new AppleBillingError("invalid_apple_transaction", "Apple signed subscription data is invalid"); }
  if (matches.length !== 1) throw new AppleBillingError("invalid_apple_transaction", "No unique eligible Apple subscription was found");
  return matches[0];
}

export function subscriptionFact(config: AppleSubscriptionConfig, realm: AppleEnvironment, status: number | undefined,
  transaction: JWSTransactionDecodedPayload, renewal: { originalTransactionId?: string; gracePeriodExpiresDate?: number; signedDate?: number; autoRenewStatus?: number }): VerifiedAppleSubscription {
  if (!transaction.productId || ![config.monthlyProductId, config.annualProductId].includes(transaction.productId) ||
      transaction.type !== "Auto-Renewable Subscription" || transaction.inAppOwnershipType !== "PURCHASED" ||
      !transaction.appAccountToken || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(transaction.appAccountToken) ||
      !transaction.originalTransactionId || !/^[0-9]{1,100}$/.test(transaction.originalTransactionId) ||
      !transaction.transactionId || !Number.isFinite(transaction.expiresDate) || !Number.isFinite(transaction.signedDate) ||
      transaction.environment !== realm || transaction.bundleId !== APPLE_BUNDLE_ID || ![1, 2, 3, 4, 5].includes(status ?? 0)) {
    throw new AppleBillingError("invalid_apple_transaction", "Apple subscription fields are invalid");
  }
  const now = Date.now();
  const signedDate = Math.max(transaction.signedDate!, renewal.signedDate ?? 0);
  if (signedDate > now + 60_000) throw new AppleBillingError("invalid_apple_transaction", "Apple subscription date is invalid");
  const expires = status === 4 ? (renewal.gracePeriodExpiresDate ?? transaction.expiresDate!) : transaction.expiresDate!;
  return { environment: realm, originalTransactionId: transaction.originalTransactionId,
    appAccountToken: transaction.appAccountToken.toLowerCase(), productId: transaction.productId,
    transactionId: transaction.transactionId, expiresAt: new Date(expires).toISOString(), signedAt: new Date(signedDate).toISOString(),
    active: !transaction.revocationDate && (status === 1 || status === 4) && expires > now,
    retrying: !transaction.revocationDate && status === 3, cancelAtPeriodEnd: renewal.autoRenewStatus === 0 };
}

export function appleBillingFact(subscription: VerifiedAppleSubscription, binding: { spaceId: string; ownerUserId: string }): BillingSubscriptionFact {
  return { billingProvider: "apple", id: `apple:${subscription.environment}:${subscription.originalTransactionId}`,
    customerId: subscription.appAccountToken, priceId: subscription.productId,
    status: subscription.active ? "active" : subscription.retrying ? "unpaid" : "canceled", quantity: 1,
    currentPeriodEnd: subscription.expiresAt, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    spaceId: binding.spaceId, billingOwnerUserId: binding.ownerUserId };
}
