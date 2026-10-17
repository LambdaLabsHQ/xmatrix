/**
 * The account calls a desktop or phone app's page makes (two-step
 * verification, linked GitHub, outside apps, sign-out), sent on with the app's
 * own session from its HTTP-only cookie. The page never holds that 30-day
 * token itself, so a script on the page cannot carry it away.
 */
const ACCOUNT_PATHS: readonly RegExp[] = [
  /^get-session$/u,
  /^two-factor\/[a-z-]+$/u,
  /^list-accounts$/u,
  /^link-social$/u,
  /^unlink-account$/u,
  /^sign-out$/u,
  /^oauth2\/(?:get-consents|delete-consent|consent|public-client)$/u,
];

export function nativeAccountPath(segments: readonly string[]): string | null {
  const path = segments.join("/");
  return ACCOUNT_PATHS.some((pattern) => pattern.test(path)) ? path : null;
}
