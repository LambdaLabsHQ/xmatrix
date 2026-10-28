import type { MachineDaemonClientMessage } from "@xmatrix/protocol/connections/machine-daemon";
import { reportError } from "@xmatrix/protocol/error-reporting";
import { boundedOccurrenceAt } from "../bounded-occurrence-time";
import type { MachineDaemonRuntimeSession } from "./machine-daemon-port";

const REASONS = ["epoch_missing", "epoch_invalid", "snapshot_epoch_stale", "epoch_future",
  "sequence_missing", "sequence_invalid"] as const;
type Reason = typeof REASONS[number];
const FRAMES = ["snapshot_full", "snapshot_partial", "snapshot_unspecified", "spawn_success"] as const;
type Frame = typeof FRAMES[number];
const CLIENT_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:beta|dev)\.\d{1,6})?$/u;

/** Fixed diagnosis only: never retain a report, identity, lease or raw causal fields. */
class MachineRegistryCausalityError extends Error {
  constructor(readonly reason: Reason, readonly frame: Frame, readonly advertised: boolean,
    readonly clientVersion: string) {
    super(`Machine Daemon registry evidence does not match the active connection (${frame}; ${reason})`);
    this.name = "MachineRegistryCausalityError";
  }
}

export function assertMachineRegistryCausality(
  session: Readonly<MachineDaemonRuntimeSession>,
  message: MachineDaemonClientMessage,
): void {
  const causalSnapshot = message.type === "machine_run_snapshot";
  const causalSpawn = message.type === "machine_spawn_result" && message.ok === true;
  if (!causalSnapshot && !causalSpawn) return;
  const advertised = session.capabilities.includes("machine_run_snapshot_causal_v1");
  const epoch = "registryConnectionEpoch" in message ? message.registryConnectionEpoch : undefined;
  const sequence = "registrySequence" in message ? message.registrySequence : undefined;
  const fieldsPresent = epoch !== undefined || sequence !== undefined ||
    causalSnapshot && message.capturedAt !== undefined;
  if (!advertised && !fieldsPresent) return;
  const reason: Reason | undefined = epoch === undefined ? "epoch_missing"
    : !Number.isSafeInteger(epoch) || Number(epoch) < 1 ? "epoch_invalid"
    : causalSnapshot && Number(epoch) < session.connectionEpoch ? "snapshot_epoch_stale"
    : Number(epoch) > session.connectionEpoch ? "epoch_future"
    : sequence === undefined ? "sequence_missing"
    : !Number.isSafeInteger(sequence) || Number(sequence) < 1 ? "sequence_invalid" : undefined;
  if (reason) {
    const frame: Frame = causalSnapshot ? message.snapshotComplete === true ? "snapshot_full"
      : message.snapshotComplete === false ? "snapshot_partial" : "snapshot_unspecified" : "spawn_success";
    const version = session.clientVersion;
    throw new MachineRegistryCausalityError(reason, frame, advertised,
      typeof version === "string" && CLIENT_VERSION.test(version) ? version : "unavailable");
  }
  if (causalSnapshot) boundedOccurrenceAt(message.capturedAt);
}

/** Keep one mapped exception instead of the socket's synthetic console stack. */
export function reportMachineRegistryCausalityFailure(error: unknown, diagnosticId: string): boolean {
  if (!(error instanceof MachineRegistryCausalityError)) return false;
  reportError(error, { operation: "runtime.machine-registry",
    fingerprint: ["machine-daemon-registry", error.frame, error.reason],
    ids: { diagnosticId, machine_registry_reason: error.reason, machine_registry_frame: error.frame,
      machine_registry_capability: error.advertised ? "advertised" : "legacy",
      machine_registry_client: error.clientVersion } });
  return true;
}

/** Sentry is untrusted: export only the bounded diagnosis this boundary owns. */
export function machineRegistryCausalityMetadata(extra: Record<string, unknown>): string[] {
  const { machine_registry_reason: reason, machine_registry_frame: frame,
    machine_registry_capability: capability, machine_registry_client: client } = extra;
  if (!REASONS.some(value => value === reason) || !FRAMES.some(value => value === frame) ||
      capability !== "advertised" && capability !== "legacy" ||
      typeof client !== "string" || client !== "unavailable" && !CLIENT_VERSION.test(client)) return [];
  return [`Machine registry rejection: ${frame} · ${reason} · ${capability} · client=${client}`];
}
