import { deploymentOrigin } from "./deployment-origins";
import type { Env } from "./types";

const COOKIE_DOMAIN_PATTERN = /^\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
const COOKIE_PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

function sharedHostnameSuffix(left: string, right: string): string | undefined {
  const leftLabels = left.toLowerCase().split(".");
  const rightLabels = right.toLowerCase().split(".");
  const shared: string[] = [];
  while (
    leftLabels.length > 0 &&
    rightLabels.length > 0 &&
    leftLabels.at(-1) === rightLabels.at(-1)
  ) {
    shared.unshift(leftLabels.pop() as string);
    rightLabels.pop();
  }
  return shared.length >= 2 ? `.${shared.join(".")}` : undefined;
}

export function resolveAuthCookieDomain(
  env: Pick<Env, "APP_URL" | "HUB_URL" | "AUTH_COOKIE_DOMAIN">,
): string | undefined {
  const appOrigin = deploymentOrigin(env.APP_URL, "APP_URL");
  const hubOrigin = deploymentOrigin(env.HUB_URL, "HUB_URL");
  const configured = env.AUTH_COOKIE_DOMAIN?.trim();
  if (!configured) return undefined;
  if (!COOKIE_DOMAIN_PATTERN.test(configured)) {
    throw new Error("AUTH_COOKIE_DOMAIN must be a lowercase dotted DNS suffix");
  }

  if (appOrigin.protocol !== "https:" || hubOrigin.protocol !== "https:") {
    throw new Error("Hosted cross-subdomain auth requires HTTPS APP_URL and HUB_URL origins");
  }

  const expected = sharedHostnameSuffix(appOrigin.hostname, hubOrigin.hostname);
  if (!expected || configured !== expected) {
    throw new Error(
      `AUTH_COOKIE_DOMAIN must equal the narrowest shared APP_URL/HUB_URL suffix (${expected ?? "none"})`,
    );
  }
  return configured;
}

export function resolveAuthCookiePrefix(
  env: Pick<Env, "AUTH_COOKIE_DOMAIN" | "AUTH_COOKIE_PREFIX">,
): string | undefined {
  const configured = env.AUTH_COOKIE_PREFIX?.trim();
  if (!configured) return undefined;
  if (!COOKIE_PREFIX_PATTERN.test(configured)) {
    throw new Error(
      "AUTH_COOKIE_PREFIX must be 1-32 lowercase letters, digits, or internal hyphens",
    );
  }
  if (!env.AUTH_COOKIE_DOMAIN?.trim()) {
    throw new Error("AUTH_COOKIE_PREFIX requires an explicit AUTH_COOKIE_DOMAIN");
  }
  return configured;
}
