"use client";

import {
  CLIENT_COMPATIBILITY_POLICY,
  CLIENT_UPGRADE_REQUIRED_CLOSE_CODE,
  deriveHumanConnectionUrl,
  evaluateClientCompatibility,
  parseClientCompatibilityIdentity,
  withClientCompatibilityQuery,
  type ClientCompatibilityDecision,
  type ClientCompatibilityIdentity,
} from "@xmatrix/protocol";
import canonicalVersion from "../../../../version.json" with { type: "json" };
import { getDesktopBridge } from "./desktop/bridge";
import { xmatrixHubOrigin } from "./query/api-client";
import { ClientAdmissionCache } from "./client-admission-cache";
import { xmatrixRawResponse } from "@/lib/query/api-client";

type CompatibilityResult = { identity: ClientCompatibilityIdentity; decision: ClientCompatibilityDecision };
const admissionCache = new ClientAdmissionCache<CompatibilityResult>();

/** Only app startup reuses admission. Socket recovery must ask the server again. */
export async function admitAppCompatibility(identity: ClientCompatibilityIdentity): Promise<CompatibilityResult> {
  const key = JSON.stringify([xmatrixHubOrigin(), identity.component, identity.version,
    identity.protocolVersion, identity.platform ?? null]);
  return admissionCache.read(key, async () => {
    const result = await requestAppCompatibility(identity);
    if (!result.decision.compatible) admissionCache.clear();
    return result;
  });
}

let acceptedIdentity: ClientCompatibilityIdentity | undefined;

export async function detectAppCompatibilityIdentity(): Promise<ClientCompatibilityIdentity> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return {
      component: "app",
      version: canonicalVersion.version,
      protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
      platform: browserPlatform(),
    };
  }
  const context = await bridge.getContext();
  const identity = parseClientCompatibilityIdentity({
    component: "app",
    version: context.version,
    protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
    platform: context.platform,
  });
  if (!identity) {
    throw new Error("The native xMatrix shell did not provide a valid version.");
  }
  return identity;
}

export async function checkAppCompatibility(): Promise<CompatibilityResult> {
  admissionCache.clear();
  return requestAppCompatibility(await detectAppCompatibilityIdentity());
}

async function requestAppCompatibility(identity: ClientCompatibilityIdentity): Promise<CompatibilityResult> {
  const response = await xmatrixRawResponse("/api/client-compatibility", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(identity),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  const decision = compatibilityDecision(payload);
  if (
    !decision ||
    response.ok !== decision.compatible ||
    (!response.ok && response.status !== 426)
  ) {
    throw new Error("The compatibility service returned an invalid response.");
  }
  if (decision.compatible) acceptedIdentity = identity;
  else acceptedIdentity = undefined;
  return { identity, decision };
}

export function requireAcceptedAppCompatibilityIdentity(): ClientCompatibilityIdentity {
  const identity = acceptedIdentity;
  if (!identity || !evaluateClientCompatibility(identity).compatible) {
    throw new Error("The app compatibility gate has not admitted this client.");
  }
  return identity;
}

/** Same charset the Hub accepts before it routes a socket to `user-<id>`. */
const RUNTIME_OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export function admittedHumanSocketUrl(hubUrl: string, ownerUserId: string): string {
  const url = new URL(withClientCompatibilityQuery(
    deriveHumanConnectionUrl(hubUrl),
    requireAcceptedAppCompatibilityIdentity(),
  ));
  if (RUNTIME_OWNER_ID.test(ownerUserId)) url.searchParams.set("owner", ownerUserId);
  return url.toString();
}

export async function humanSocketRequiresUpgrade(
  closeCode: number,
  check: typeof checkAppCompatibility = checkAppCompatibility,
): Promise<boolean> {
  if (closeCode === CLIENT_UPGRADE_REQUIRED_CLOSE_CODE) return true;
  if (closeCode !== 1006) return false;
  try {
    return !(await check()).decision.compatible;
  } catch {
    return false;
  }
}

export function openAppUpgradeWall(): void {
  window.location.replace("/upgrade-required");
}

/**
 * What a closed Human socket does next. A close that may mean this app is too
 * old asks the Hub first, and opens the upgrade wall instead of redialling.
 */
const UPGRADE_CHECK_TIMEOUT_MS = 10_000;

export async function humanSocketCloseDecision(closeCode: number): Promise<"reconnect" | "stop"> {
  if (closeCode !== CLIENT_UPGRADE_REQUIRED_CLOSE_CODE && closeCode !== 1006) return "reconnect";
  // A check stuck on a half-dead network must not hold the redial forever.
  const upgradeRequired = await Promise.race([
    humanSocketRequiresUpgrade(closeCode),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), UPGRADE_CHECK_TIMEOUT_MS)),
  ]);
  if (!upgradeRequired) return "reconnect";
  openAppUpgradeWall();
  return "stop";
}

function compatibilityDecision(value: unknown): ClientCompatibilityDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<ClientCompatibilityDecision>;
  if (
    typeof input.compatible !== "boolean" ||
    (input.code !== "compatible" && input.code !== "client_upgrade_required") ||
    typeof input.protocolVersion !== "number" ||
    typeof input.upgradeUrl !== "string"
  ) return undefined;
  return input as ClientCompatibilityDecision;
}

function browserPlatform(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || navigator.platform || undefined;
}
