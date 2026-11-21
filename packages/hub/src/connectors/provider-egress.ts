import { isPublicHttpsUrl } from "./http";

/*
 * Some providers refuse calls from Cloudflare Workers' shared egress
 * addresses. Bing Webmaster answers every one with `ThrottleIP`, so its calls
 * go through a relay outside Cloudflare (`deploy/bing-relay`) when the
 * deployment configures one. Without configuration the Hub calls the
 * provider directly, as before.
 */

export interface ProviderEgress {
  /** The relay's origin; the provider path follows it. */
  origin: string;
  /** Bearer token the relay checks against the SHA-256 it holds. */
  token: string;
}

const RELAYED = { bingwebmaster: ["CONNECTOR_BING_RELAY_URL", "CONNECTOR_BING_RELAY_TOKEN"] } as const;

/** The relay a provider's calls go through, or undefined to call it directly. */
export function providerEgress(env: unknown, providerId: string): ProviderEgress | undefined {
  const names = (RELAYED as Record<string, readonly [string, string] | undefined>)[providerId];
  if (!names) return undefined;
  const variables = env as Record<string, unknown>;
  const [address, token] = [variables[names[0]], variables[names[1]]];
  if (typeof address !== "string" || typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/u.test(token)) return undefined;
  let url: URL;
  try { url = new URL(address); } catch { return undefined; }
  return isPublicHttpsUrl(url) && url.pathname === "/" && !url.search && !url.hash && !url.username ? { origin: url.origin, token } : undefined;
}
