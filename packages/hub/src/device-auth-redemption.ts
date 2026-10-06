import type { AuthSession } from "./auth";

export interface RedeemableDeviceAuthSession {
  issuedSession?: AuthSession;
}

export interface DeviceAuthRedemptionResult {
  issuedSession: AuthSession;
  replayed: boolean;
}

export function boundedRedemptionExpiry(
  authorizationExpiresAt: string,
  issuedAt: string,
  replayWindowMs: number,
): string {
  return new Date(Math.min(
    Date.parse(authorizationExpiresAt),
    Date.parse(issuedAt) + replayWindowMs,
  )).toISOString();
}

interface RedeemDeviceAuthOptions {
  deviceCode: string;
  session: RedeemableDeviceAuthSession;
  issue: () => Promise<AuthSession>;
  persist: (issuedSession: AuthSession, issuedAt: string) => Promise<void>;
}

/**
 * Keeps device-token redemption retry-safe across duplicate requests and lost
 * responses. Durable storage handles later retries; the in-memory promise
 * closes the smaller window where concurrent polls arrive before persistence.
 */
export class DeviceAuthRedemptionCoordinator {
  private readonly inFlight = new Map<string, Promise<AuthSession>>();

  async redeem(options: RedeemDeviceAuthOptions): Promise<DeviceAuthRedemptionResult> {
    if (options.session.issuedSession) {
      return { issuedSession: options.session.issuedSession, replayed: true };
    }

    const existing = this.inFlight.get(options.deviceCode);
    if (existing) {
      return { issuedSession: await existing, replayed: true };
    }

    const issuance = (async () => {
      const issuedSession = await options.issue();
      await options.persist(issuedSession, new Date().toISOString());
      return issuedSession;
    })();
    this.inFlight.set(options.deviceCode, issuance);

    try {
      return { issuedSession: await issuance, replayed: false };
    } finally {
      if (this.inFlight.get(options.deviceCode) === issuance) {
        this.inFlight.delete(options.deviceCode);
      }
    }
  }
}
