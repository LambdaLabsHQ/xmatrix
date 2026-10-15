import { parseAppleSubscriptionConfig, type AppleSubscriptionConfig } from "@xmatrix/protocol";
import { Buffer } from "node:buffer";
import type { JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import { importPKCS8, SignJWT } from "jose";
import type { AppleSeatGroupState, BillingSubscriptionFact } from "@xmatrix/db";
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
      if (!transaction.originalTransactionId) return null;
      // An organization's assigned seat carries no account token; it is matched by its transaction.
      if (transaction.inAppOwnershipType === "ASSIGNED") return { transactionId: transaction.originalTransactionId, environment: realm, assigned: true };
      if (!transaction.appAccountToken) return null;
      return { transactionId: transaction.originalTransactionId, appAccountToken: transaction.appAccountToken, environment: realm, assigned: false };
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
  /** An organization's seat assigned to this person: no account token, matched by its transaction. */
  assigned: boolean;
  /** Empty for an assigned seat. */
  appAccountToken: string;
  productId: string;
  transactionId: string;
  expiresAt: string;
  signedAt: string;
  active: boolean;
  retrying: boolean;
  cancelAtPeriodEnd: boolean;
  /** Seats the purchaser bought; Apple's multiseat purchases carry more than one. */
  seats: number;
}

async function serverToken(config: AppleSubscriptionConfig): Promise<string> {
  try {
    const key = await importPKCS8(config.privateKey, "ES256");
    return await new SignJWT({ bid: APPLE_BUNDLE_ID }).setProtectedHeader({ alg: "ES256", kid: config.keyId, typ: "JWT" })
      .setIssuer(config.issuerId).setAudience("appstoreconnect-v1").setIssuedAt().setExpirationTime("5m").sign(key);
  } catch { throw new AppleBillingError("apple_signing_failed", "Apple subscription signing is temporarily unavailable", true); }
}

const storeKitHost = (realm: AppleEnvironment) => realm === "Production" ? "https://api.storekit.apple.com" : "https://api.storekit-sandbox.apple.com";

/**
 * The organization (Volume Purchasing) group a customer's seat comes from, or
 * null when Apple names none or cannot say: Get Customer Groups is new, and at
 * first Apple serves it only in the sandbox. Groups decide where people meet,
 * never entitlement, which always comes from the signed transaction.
 */
export async function appleOrganizationGroup(config: AppleSubscriptionConfig, realm: AppleEnvironment, transactionId: string,
  fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!/^[0-9]{1,100}$/.test(transactionId)) return null;
  const token = await serverToken(config);
  let response: Response;
  try {
    response = await fetchImpl(`${storeKitHost(realm)}/groups/v1/currentGroups/${transactionId}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch { return null; }
  if (!response.ok) { await response.body?.cancel(); return null; }
  let body: unknown;
  try { body = await boundedJson(response); } catch { return null; }
  const groups = body && typeof body === "object" && Array.isArray((body as { groups?: unknown }).groups) ? (body as { groups: unknown[] }).groups : [];
  for (const group of groups.slice(0, 20)) {
    const entry = group && typeof group === "object" ? group as { groupId?: unknown; groupType?: unknown } : {};
    if (entry.groupType === "ORGANIZATION" && typeof entry.groupId === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(entry.groupId)) return entry.groupId;
  }
  return null;
}

export async function retrieveAppleSubscription(config: AppleSubscriptionConfig, transactionId: unknown,
  realmValue: unknown, fetchImpl: typeof fetch = fetch): Promise<VerifiedAppleSubscription> {
  const realm = environment(realmValue);
  if (typeof transactionId !== "string" || !/^[0-9]{1,100}$/.test(transactionId)) throw new AppleBillingError("invalid_apple_transaction", "Invalid Apple transaction");
  const host = storeKitHost(realm);
  let response: Response;
  const token = await serverToken(config);
  try {
    response = await fetchImpl(`${host}/inApps/v1/subscriptions/${transactionId}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(10_000),
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
      if (!record.signedTransactionInfo) continue;
      const transaction = await check.verifyAndDecodeTransaction(record.signedTransactionInfo);
      // An assigned seat renews on the organization's side; its renewal info may be absent.
      if (!record.signedRenewalInfo && transaction.inAppOwnershipType !== "ASSIGNED") continue;
      const renewal = record.signedRenewalInfo ? await check.verifyAndDecodeRenewalInfo(record.signedRenewalInfo)
        : { originalTransactionId: transaction.originalTransactionId };
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
      transaction.type !== "Auto-Renewable Subscription" ||
      (transaction.inAppOwnershipType === "PURCHASED" ? !transaction.appAccountToken ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(transaction.appAccountToken) : transaction.inAppOwnershipType !== "ASSIGNED") ||
      !transaction.originalTransactionId || !/^[0-9]{1,100}$/.test(transaction.originalTransactionId) ||
      !transaction.transactionId || !Number.isFinite(transaction.expiresDate) || !Number.isFinite(transaction.signedDate) ||
      transaction.environment !== realm || transaction.bundleId !== APPLE_BUNDLE_ID || ![1, 2, 3, 4, 5].includes(status ?? 0) ||
      !Number.isSafeInteger(transaction.quantity ?? 1) || (transaction.quantity ?? 1) < 1 || (transaction.quantity ?? 1) > 99) {
    throw new AppleBillingError("invalid_apple_transaction", "Apple subscription fields are invalid");
  }
  const now = Date.now();
  const signedDate = Math.max(transaction.signedDate!, renewal.signedDate ?? 0);
  if (signedDate > now + 60_000) throw new AppleBillingError("invalid_apple_transaction", "Apple subscription date is invalid");
  const expires = status === 4 ? (renewal.gracePeriodExpiresDate ?? transaction.expiresDate!) : transaction.expiresDate!;
  return { environment: realm, originalTransactionId: transaction.originalTransactionId,
    assigned: transaction.inAppOwnershipType === "ASSIGNED", appAccountToken: transaction.appAccountToken?.toLowerCase() ?? "", productId: transaction.productId,
    transactionId: transaction.transactionId, expiresAt: new Date(expires).toISOString(), signedAt: new Date(signedDate).toISOString(),
    active: !transaction.revocationDate && (status === 1 || status === 4) && expires > now,
    retrying: !transaction.revocationDate && status === 3, cancelAtPeriodEnd: renewal.autoRenewStatus === 0,
    seats: transaction.quantity ?? 1 };
}

/** The billing fact of an organization's seats in its Space: one subscription whose seats are the active assigned ones. */
export function appleSeatGroupFact(environment: AppleEnvironment, group: AppleSeatGroupState): BillingSubscriptionFact {
  const seats = Math.min(Math.max(group.activeSeats, 1), 99);
  return { billingProvider: "apple", id: `apple:${environment}:${group.groupKey}`, customerId: group.groupKey, priceId: group.productId,
    status: group.activeSeats > 0 && Date.parse(group.periodEnd) > Date.now() ? "active" : "canceled", quantity: seats,
    currentPeriodEnd: group.periodEnd, cancelAtPeriodEnd: false, spaceId: group.spaceId, billingOwnerUserId: group.ownerUserId };
}

export function appleBillingFact(subscription: VerifiedAppleSubscription, binding: { spaceId: string; ownerUserId: string; accountDeleted?: boolean }): BillingSubscriptionFact {
  if (binding.accountDeleted) throw new AppleBillingError("apple_purchase_account_deleted", "Deleted accounts cannot receive subscription access");
  if (subscription.assigned) throw new AppleBillingError("invalid_apple_transaction", "An assigned seat is counted with its organization");
  return { billingProvider: "apple", id: `apple:${subscription.environment}:${subscription.originalTransactionId}`,
    customerId: subscription.appAccountToken, priceId: subscription.productId,
    status: subscription.active ? "active" : subscription.retrying ? "unpaid" : "canceled", quantity: subscription.seats,
    currentPeriodEnd: subscription.expiresAt, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    spaceId: binding.spaceId, billingOwnerUserId: binding.ownerUserId };
}
