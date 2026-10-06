import policyJson from "./client-compatibility-policy.json" with { type: "json" };

export const CLIENT_COMPATIBILITY_PATH = "/api/client-compatibility";
export const CLIENT_COMPATIBILITY_HEADERS = Object.freeze({
  component: "x-xmatrix-client-component",
  version: "x-xmatrix-client-version",
  protocol: "x-xmatrix-client-protocol",
  platform: "x-xmatrix-client-platform",
});
export const CLIENT_UPGRADE_REQUIRED_CLOSE_CODE = 4003;

export type ClientCompatibilityComponent = "app" | "cli" | "daemon";
export type ClientCompatibilityReason =
  | "compatible"
  | "identity_missing"
  | "identity_invalid"
  | "protocol_unsupported"
  | "version_too_old";

export interface ClientCompatibilityIdentity {
  component: ClientCompatibilityComponent;
  version: string;
  protocolVersion: number;
  platform?: string;
}

export interface ClientCompatibilityDecision {
  compatible: boolean;
  code: "compatible" | "client_upgrade_required";
  reason: ClientCompatibilityReason;
  component: ClientCompatibilityComponent | null;
  currentVersion: string | null;
  minimumVersion: string | null;
  protocolVersion: number;
  retryable: false;
  upgradeUrl: string;
  updateCommand?: "xmatrix update";
  error?: string;
}

type ParsedSemver = {
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[];
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const COMPONENTS = new Set<ClientCompatibilityComponent>(["app", "cli", "daemon"]);
const policy = policyJson as {
  schemaVersion: number;
  protocolVersion: number;
  minimumVersions: Record<ClientCompatibilityComponent, string>;
  upgradeUrl: string;
};

export const CLIENT_COMPATIBILITY_POLICY = Object.freeze({
  schemaVersion: policy.schemaVersion,
  protocolVersion: policy.protocolVersion,
  minimumVersions: Object.freeze({ ...policy.minimumVersions }),
  upgradeUrl: policy.upgradeUrl,
});

export function parseClientVersion(value: unknown): ParsedSemver | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(SEMVER);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) {
    return undefined;
  }
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease,
  };
}

export function compareClientVersions(left: string, right: string): number | undefined {
  const a = parseClientVersion(left);
  const b = parseClientVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index]! < b.core[index]!) return -1;
    if (a.core[index]! > b.core[index]!) return 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === bPart ? 0 : aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/u.test(aPart);
    const bNumeric = /^\d+$/u.test(bPart);
    if (aNumeric && bNumeric) return BigInt(aPart) < BigInt(bPart) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

export function parseClientCompatibilityIdentity(value: unknown): ClientCompatibilityIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const component = typeof input.component === "string" ? input.component.trim() : "";
  const version = typeof input.version === "string" ? input.version.trim() : "";
  const protocolVersion = Number(input.protocolVersion);
  const platform = typeof input.platform === "string" ? input.platform.trim().slice(0, 64) : "";
  if (
    !COMPONENTS.has(component as ClientCompatibilityComponent) ||
    !parseClientVersion(version) ||
    !Number.isSafeInteger(protocolVersion) ||
    protocolVersion < 1
  ) return undefined;
  return {
    component: component as ClientCompatibilityComponent,
    version,
    protocolVersion,
    ...(platform ? { platform } : {}),
  };
}

export function evaluateClientCompatibility(value: unknown): ClientCompatibilityDecision {
  const identity = parseClientCompatibilityIdentity(value);
  if (!identity) return incompatibleDecision(value, "identity_invalid");
  if (identity.protocolVersion !== CLIENT_COMPATIBILITY_POLICY.protocolVersion) {
    return incompatibleDecision(identity, "protocol_unsupported");
  }
  const minimumVersion = CLIENT_COMPATIBILITY_POLICY.minimumVersions[identity.component];
  const comparison = compareClientVersions(identity.version, minimumVersion);
  if (comparison === undefined || comparison < 0) {
    return incompatibleDecision(identity, "version_too_old");
  }
  return {
    compatible: true,
    code: "compatible",
    reason: "compatible",
    component: identity.component,
    currentVersion: identity.version,
    minimumVersion,
    protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
    retryable: false,
    upgradeUrl: CLIENT_COMPATIBILITY_POLICY.upgradeUrl,
  };
}

export function missingClientCompatibilityDecision(): ClientCompatibilityDecision {
  return incompatibleDecision(undefined, "identity_missing");
}

export function clientCompatibilityHeaders(identity: ClientCompatibilityIdentity): Record<string, string> {
  return {
    [CLIENT_COMPATIBILITY_HEADERS.component]: identity.component,
    [CLIENT_COMPATIBILITY_HEADERS.version]: identity.version,
    [CLIENT_COMPATIBILITY_HEADERS.protocol]: String(identity.protocolVersion),
    ...(identity.platform ? { [CLIENT_COMPATIBILITY_HEADERS.platform]: identity.platform } : {}),
  };
}

/**
 * Browser WebSocket constructors cannot attach request headers. Put the same
 * non-secret compatibility identity on the upgrade URL so Hub admission can
 * reject an obsolete browser shell before resolving a Durable Object.
 */
export function withClientCompatibilityQuery(
  input: string | URL,
  identity: ClientCompatibilityIdentity,
): string {
  const url = new URL(input);
  for (const [name, value] of Object.entries(clientCompatibilityHeaders(identity))) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function incompatibleDecision(
  value: unknown,
  reason: Exclude<ClientCompatibilityReason, "compatible">,
): ClientCompatibilityDecision {
  const identity = parseClientCompatibilityIdentity(value);
  const component = identity?.component ?? componentFromValue(value);
  const currentVersion = identity?.version ?? versionFromValue(value);
  const minimumVersion = component
    ? CLIENT_COMPATIBILITY_POLICY.minimumVersions[component]
    : null;
  const subject = component === "daemon" ? "xMatrix daemon"
    : component === "cli" ? "xMatrix CLI"
    : component === "app" ? "xMatrix app"
    : "This xMatrix client";
  const requirement = minimumVersion ? ` ${minimumVersion} or later` : " the latest version";
  return {
    compatible: false,
    code: "client_upgrade_required",
    reason,
    component,
    currentVersion,
    minimumVersion,
    protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
    retryable: false,
    upgradeUrl: CLIENT_COMPATIBILITY_POLICY.upgradeUrl,
    ...(component === "cli" || component === "daemon" ? { updateCommand: "xmatrix update" as const } : {}),
    error: `${subject} is no longer compatible. Update to version${requirement} before reconnecting.`,
  };
}

function componentFromValue(value: unknown): ClientCompatibilityComponent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const component = (value as Record<string, unknown>).component;
  return typeof component === "string" && COMPONENTS.has(component as ClientCompatibilityComponent)
    ? component as ClientCompatibilityComponent
    : null;
}

function versionFromValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = (value as Record<string, unknown>).version;
  return typeof version === "string" && version.trim() ? version.trim().slice(0, 64) : null;
}
