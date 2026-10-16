import { sha256Hex } from "@xmatrix/protocol";

type AuthMetricInput = {
  routeGroup: string;
  status: number;
  outcome?: string;
  authProvider?: string;
  userId?: string;
};

export async function logAuthMetric(input: AuthMetricInput): Promise<void> {
  const userIdHash = input.userId ? await hashForLog(input.userId) : undefined;
  console.log(
    JSON.stringify({
      event: "xmatrix_auth_metric",
      minute: minuteBucket(),
      routeGroup: input.routeGroup,
      status: input.status,
      outcome: input.outcome,
      authProvider: input.authProvider,
      userIdHash,
    })
  );
}

function minuteBucket(): string {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
}

async function hashForLog(value: string): Promise<string> {
  return (await sha256Hex(value)).slice(0, 24);
}

export function betterAuthRouteGroup(path: string, status?: number): string {
  if (path.endsWith("/token")) {
    return status === 401 || status === 403 || status === 429
      ? `auth_token_${status}`
      : "auth_token";
  }
  if (path.includes("/sign-in/social")) return "google_sign_in";
  if (path.includes("/callback/google")) return "google_callback";
  if (path.includes("/email-otp/")) return "better_auth_email_otp";
  if (path.includes("/sign-in/email-otp")) return "better_auth_email_otp";
  if (path.endsWith("/sign-in/email")) return "better_auth_password";
  if (path.includes("/request-password-reset") || path.includes("/reset-password")) return "better_auth_password_reset";
  if (path.includes("/get-session")) return "better_auth_get_session";
  if (path.includes("/jwks")) return "better_auth_jwks";
  return "better_auth";
}
export async function logBetterAuthHandlerMetrics(path: string, response: Response) {
  const routeGroup = betterAuthRouteGroup(path, response.status);
  const oauthCallback = /^\/api\/auth\/callback\/(google|github)$/u.test(path);
  // Better Auth rejects OAuth callbacks with a 302 carrying an error, so HTTP
  // success alone says nothing about whether a sign-in completed. Read only
  // the presence of the error; callback URLs and provider text stay private.
  const location = response.headers.get("location");
  const callbackRejected = oauthCallback && location !== null
    && new URL(location, "https://auth.invalid").searchParams.has("error");
  await logAuthMetric({
    routeGroup,
    status: response.status,
    outcome: !callbackRejected && response.status < 400 ? "ok" : "error",
    authProvider: "better-auth",
  });

  const sessionIssued = response.headers.getSetCookie().some((cookie) =>
    /^(?:__Secure-)?[^=;\s]+\.session_token=[^;\s]+/u.test(cookie));
  if (path === "/api/auth/callback/google" && !callbackRejected && sessionIssued
      && response.status >= 200 && response.status < 400) {
    await logAuthMetric({
      routeGroup: "session_created",
      status: response.status,
      outcome: "google_callback",
      authProvider: "better-auth",
    });
  }

  if ((path.includes("/sign-in/email-otp") || path.endsWith("/sign-in/email")) && response.ok) {
    await logAuthMetric({
      routeGroup: "session_created",
      status: response.status,
      outcome: path.endsWith("/sign-in/email") ? "better_auth_password" : "better_auth_email_otp",
      authProvider: "better-auth",
    });
  }

  if (path.endsWith("/token") && response.ok) {
    await logAuthMetric({
      routeGroup: "session_reused",
      status: response.status,
      outcome: "auth_token",
      authProvider: "better-auth",
    });
  }
}
