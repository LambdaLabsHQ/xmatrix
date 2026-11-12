/**
 * Private configuration for Google Play subscriptions. The service account
 * reads and acknowledges purchases through the Google Play Developer API; the
 * push identity is the service account Pub/Sub signs Real-time developer
 * notifications as, so the Hub can verify each push it receives.
 */
export interface GooglePlaySubscriptionConfig {
  serviceAccountEmail: string;
  privateKey: string;
  /** One Play subscription product whose base plans are the billing periods. */
  subscriptionId: string;
  monthlyBasePlanId: string;
  annualBasePlanId: string;
  /** The audience the Pub/Sub push subscription puts in its OIDC token. */
  pushAudience: string;
  pushServiceAccountEmail: string;
  /** Spaces allowed to receive license-tester (test) purchases; empty refuses them all. */
  testSpaceIds: string[];
}

const SERVICE_ACCOUNT = /^[a-z0-9-]{1,100}@[a-z0-9-]{1,100}\.iam\.gserviceaccount\.com$/;
const PLAY_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function parseGooglePlaySubscriptionConfig(raw: string | undefined): GooglePlaySubscriptionConfig {
  try {
    if (!raw || raw.length > 32_768) throw new Error();
    const value = JSON.parse(raw);
    const fields = ["serviceAccountEmail", "privateKey", "subscriptionId", "monthlyBasePlanId", "annualBasePlanId",
      "pushAudience", "pushServiceAccountEmail", "testSpaceIds"];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key)) ||
        typeof value.serviceAccountEmail !== "string" || !SERVICE_ACCOUNT.test(value.serviceAccountEmail) ||
        typeof value.pushServiceAccountEmail !== "string" || !SERVICE_ACCOUNT.test(value.pushServiceAccountEmail) ||
        typeof value.privateKey !== "string" || !value.privateKey.startsWith("-----BEGIN PRIVATE KEY-----") ||
        typeof value.pushAudience !== "string" || !/^https:\/\/[^\s]{1,300}$/.test(value.pushAudience) ||
        !Array.isArray(value.testSpaceIds) || value.testSpaceIds.length > 20 ||
        value.testSpaceIds.some((id: unknown) => typeof id !== "string" || !id || id.length > 300)) throw new Error();
    for (const field of ["subscriptionId", "monthlyBasePlanId", "annualBasePlanId"]) {
      if (typeof value[field] !== "string" || !PLAY_ID.test(value[field])) throw new Error();
    }
    if (value.monthlyBasePlanId === value.annualBasePlanId) throw new Error();
    return value as GooglePlaySubscriptionConfig;
  } catch { throw new Error("Invalid Google Play subscription configuration"); }
}
