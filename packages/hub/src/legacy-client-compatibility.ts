import { evaluateClientCompatibility } from "@xmatrix/protocol";
import {
  CLIENT_COMPATIBILITY_POLICY,
  compareClientVersions,
  type ClientCompatibilityComponent,
} from "@xmatrix/protocol";

export const LEGACY_CLIENT_COMPATIBILITY_MAX_VERSION = "0.15.63";

/**
 * The published pre-boundary daemon generation reports its semantic version
 * in the typed realtime connect frame but has no protocol field. Translate
 * only that closed release range; explicit protocol values are never changed.
 */
export function admittedDaemonProtocolVersion(
  clientVersion: unknown,
  protocolVersion: unknown,
  allowLegacyProtocol: boolean,
): unknown {
  return admittedLegacyProtocolVersion(
    "daemon",
    clientVersion,
    protocolVersion,
    allowLegacyProtocol,
  );
}

/**
 * Published clients immediately before the protocol-identity boundary sent a
 * semantic version but omitted the realtime protocol field. The current Hub
 * translates only those already-published versions; it never routes them to a
 * second authority or rewrites an explicit protocol value.
 */
export function admittedLegacyProtocolVersion(
  component: ClientCompatibilityComponent | undefined,
  clientVersion: unknown,
  protocolVersion: unknown,
  allowLegacyProtocol: boolean,
): unknown {
  return allowLegacyProtocol && protocolVersion === undefined && component !== undefined &&
      legacyClientVersionCompatible(component, clientVersion)
    ? CLIENT_COMPATIBILITY_POLICY.protocolVersion
    : protocolVersion;
}

function legacyClientVersionCompatible(
  component: ClientCompatibilityComponent,
  clientVersion: unknown,
): boolean {
  if (typeof clientVersion !== "string") return false;
  const minimum = CLIENT_COMPATIBILITY_POLICY.minimumVersions[component];
  const aboveMinimum = compareClientVersions(clientVersion, minimum);
  const belowMaximum = compareClientVersions(clientVersion, LEGACY_CLIENT_COMPATIBILITY_MAX_VERSION);
  return aboveMinimum !== undefined && aboveMinimum >= 0 &&
    belowMaximum !== undefined && belowMaximum <= 0;
}

export function daemonClientCompatibility(
  clientVersion: unknown,
  protocolVersion: unknown,
  allowLegacyProtocol = false,
) {
  return evaluateClientCompatibility({
    component: "daemon",
    version: clientVersion,
    protocolVersion: admittedDaemonProtocolVersion(
      clientVersion,
      protocolVersion,
      allowLegacyProtocol,
    ),
  });
}
