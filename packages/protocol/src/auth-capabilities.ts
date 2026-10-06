/**
 * Session capability contract.
 *
 * Capabilities describe what the Hub will let the authenticated principal do
 * beyond its own Spaces. They are advisory for clients — every capability is
 * re-checked by the Hub on the route that uses it — so a client that forges one
 * gains nothing but a rejected request.
 */

import type { AuthUser } from "./authority.js";

export interface AuthCapabilities {
  /** Operator on the Hub platform-admin allowlist. */
  platformAdmin: boolean;
  /** Signed-in member of the deployment-pinned Test access Space. */
  testEnvironment?: boolean;
}

export interface MeResponse {
  user: AuthUser;
  hubUrl: string;
  relayUrl: string;
  capabilities: AuthCapabilities;
}
