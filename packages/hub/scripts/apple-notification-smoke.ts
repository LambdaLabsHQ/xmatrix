#!/usr/bin/env tsx

import process from "node:process";
import { importPKCS8, SignJWT } from "jose";

import { APPLE_BUNDLE_ID, appleSubscriptionConfig, AppleBillingError, retrieveAppleSubscription,
  type AppleEnvironment, type AppleSubscriptionConfig } from "../src/apple/subscriptions";

/*
 * After a release: Apple sends a TEST notification to the Hub and reports what
 * the Hub answered; with APPLE_SMOKE_TRANSACTION_ID, an existing sandbox
 * subscription is also verified again through Apple's API and our checks. No
 * device and no purchase. Apple being unreachable is a warning, not a failed
 * release; the Hub refusing Apple's notification is a failure.
 */

/**
 * Ask Apple to send a TEST notification to the URL configured for this
 * environment, and read back what our server answered: App Store Connect's
 * URL, Apple's signature and our verification, end to end.
 */
export async function appleTestNotificationRoundTrip(config: AppleSubscriptionConfig, realm: AppleEnvironment,
  options: { fetchImpl?: typeof fetch; attempts?: number; delayMs?: number } = {}): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = realm === "Production" ? "https://api.storekit.apple.com" : "https://api.storekit-sandbox.apple.com";
  const key = await importPKCS8(config.privateKey, "ES256");
  const call = async (path: string, method: "GET" | "POST"): Promise<Record<string, unknown>> => {
    const token = await new SignJWT({ bid: APPLE_BUNDLE_ID }).setProtectedHeader({ alg: "ES256", kid: config.keyId, typ: "JWT" })
      .setIssuer(config.issuerId).setAudience("appstoreconnect-v1").setIssuedAt().setExpirationTime("5m").sign(key);
    let response: Response;
    try {
      response = await fetchImpl(`${host}${path}`, { method, headers: { authorization: `Bearer ${token}` },
        redirect: "manual", signal: AbortSignal.timeout(10_000) });
    } catch { throw new AppleBillingError("apple_request_failed", "Apple's test notification service is unreachable", true); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppleBillingError("apple_request_failed", `Apple's test notification service returned ${response.status}`,
        response.status >= 500 || response.status === 429);
    }
    const body: unknown = await response.json().catch(() => null);
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  };
  const sent = await call("/inApps/v1/notifications/test", "POST");
  const testToken = typeof sent.testNotificationToken === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(sent.testNotificationToken)
    ? sent.testNotificationToken : "";
  if (!testToken) throw new AppleBillingError("apple_response_invalid", "Apple did not return a test notification token");
  for (let attempt = 0; attempt < (options.attempts ?? 12); attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5_000));
    const status = await call(`/inApps/v1/notifications/test/${testToken}`, "GET");
    const results = (Array.isArray(status.sendAttempts) ? status.sendAttempts : []).slice(0, 6)
      .map((item) => String((item as { sendAttemptResult?: unknown } | null)?.sendAttemptResult ?? "UNKNOWN"));
    if (results.length) return results;
  }
  throw new AppleBillingError("apple_request_failed", "Apple recorded no attempt to send the test notification", true);
}

async function main(): Promise<number> {
  if (!process.env.APPLE_SUBSCRIPTIONS_CONFIG) {
    console.log("App Store subscriptions are not configured; nothing to check.");
    return 0;
  }
  const config = appleSubscriptionConfig(process.env.APPLE_SUBSCRIPTIONS_CONFIG);
  const realm: AppleEnvironment = process.env.APPLE_SMOKE_ENVIRONMENT === "Production" ? "Production" : "Sandbox";
  let failed = false;
  try {
    const results = await appleTestNotificationRoundTrip(config, realm);
    if (results.includes("SUCCESS")) console.log(`Apple's ${realm} TEST notification reached the Hub and was accepted.`);
    else { console.log(`::error::Apple's ${realm} TEST notification was not accepted by the Hub: ${results.join(", ")}`); failed = true; }
  } catch (error) {
    if (!(error instanceof AppleBillingError) || !error.retryable) throw error;
    console.log(`::warning::${error.message}; the notification path was not checked this time.`);
  }
  const transactionId = process.env.APPLE_SMOKE_TRANSACTION_ID?.trim();
  if (transactionId) {
    try {
      const subscription = await retrieveAppleSubscription(config, transactionId, realm);
      console.log(`The ${realm} subscription verifies: ${subscription.active ? "active" : "not active"}, ` +
        `${subscription.seats} seat(s), ${subscription.assigned ? "assigned by an organization" : "purchased"}.`);
    } catch (error) {
      if (error instanceof AppleBillingError && error.retryable) console.log(`::warning::${error.message}; the subscription was not checked this time.`);
      else { console.log(`::error::The ${realm} subscription no longer verifies: ${error instanceof Error ? error.message : "unknown error"}`); failed = true; }
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("apple-notification-smoke.ts")) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.log(`::error::${error instanceof Error ? error.message : "App Store smoke check failed"}`);
    process.exitCode = 1;
  });
}
