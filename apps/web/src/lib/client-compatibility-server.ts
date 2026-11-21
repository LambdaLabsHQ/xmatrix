import {
  CLIENT_COMPATIBILITY_HEADERS,
  evaluateClientCompatibility,
  parseClientCompatibilityIdentity,
  type ClientCompatibilityIdentity,
} from "@xmatrix/protocol";

export const APP_COMPATIBILITY_COOKIE = "xmatrix_app_compatibility";

export function serializeAppCompatibilityCookie(identity: ClientCompatibilityIdentity): string {
  return [
    identity.component,
    identity.version,
    String(identity.protocolVersion),
    identity.platform ?? "",
  ].map(encodeURIComponent).join("|");
}

export function parseAppCompatibilityCookie(value: string | undefined): ClientCompatibilityIdentity | undefined {
  if (!value || value.length > 256) return undefined;
  const parts = value.split("|");
  if (parts.length !== 4) return undefined;
  try {
    const identity = parseClientCompatibilityIdentity({
      component: decodeURIComponent(parts[0]!),
      version: decodeURIComponent(parts[1]!),
      protocolVersion: decodeURIComponent(parts[2]!),
      platform: decodeURIComponent(parts[3]!),
    });
    return identity?.component === "app" && evaluateClientCompatibility(identity).compatible
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The identity a request names in its own headers. The extension's side panel
 * gets no cookies, so its calls carry the identity the cookie would; it must
 * be a compatible app, as the cookie must.
 */
export function parseAppCompatibilityHeaders(headers: Pick<Headers, "get">): ClientCompatibilityIdentity | undefined {
  const component = headers.get(CLIENT_COMPATIBILITY_HEADERS.component);
  if (!component) return undefined;
  const identity = parseClientCompatibilityIdentity({
    component,
    version: headers.get(CLIENT_COMPATIBILITY_HEADERS.version) ?? "",
    protocolVersion: headers.get(CLIENT_COMPATIBILITY_HEADERS.protocol) ?? "",
    platform: headers.get(CLIENT_COMPATIBILITY_HEADERS.platform) ?? "",
  });
  return identity?.component === "app" && evaluateClientCompatibility(identity).compatible ? identity : undefined;
}

export function appCompatibilityRequiredForProxyRoute(route: string): boolean {
  const pathname = new URL(route, "https://xmatrix.invalid").pathname;
  if (pathname.startsWith("/api/auth/")) return false;
  if (pathname.startsWith("/api/space-invites/")) return false;
  return true;
}
