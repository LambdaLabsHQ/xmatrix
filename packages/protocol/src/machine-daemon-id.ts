/**
 * Daemon identity.
 *
 * A host-derived Machine (`machine:<sha256>`, docs/architecture/machine-identity.md)
 * has exactly one daemon per owner: `host_id` is only the latest observed host
 * name, so the daemon id is a SHA-256 digest of `(owner, machine)` and a
 * hostname change keeps it. A legacy minted `machine:<uuid>` keeps its 32-bit
 * FNV-1a id over `(owner, machine, host)` until the machine adopts its derived
 * id, so rows written before adoption stay addressable.
 */

import { lowercaseHex, sha256BytesSync } from "./hex.js";

const DERIVED_MACHINE_ID = /^machine:[0-9a-f]{64}$/u;

export function isHostDerivedMachineId(machineId: string): boolean {
  return DERIVED_MACHINE_ID.test(machineId);
}

export function stableMachineDaemonId(ownerUserId: string, machineId: string, hostId: string): string {
  if (isHostDerivedMachineId(machineId)) {
    return `daemon:${sha256HexSync(`${ownerUserId}\0${machineId}`)}`;
  }
  return legacyMachineDaemonId(ownerUserId, machineId, hostId);
}

/** The FNV-1a id every Machine's daemon had before host-derived Machines moved to SHA-256. */
export function legacyMachineDaemonId(ownerUserId: string, machineId: string, hostId: string): string {
  const input = `${ownerUserId}\0${machineId}\0${hostId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `daemon:${hash.toString(16).padStart(8, "0")}`;
}

/** Synchronous SHA-256 of the UTF-8 encoding; daemon ids are computed inside synchronous SQL paths. */
export function sha256HexSync(value: string): string {
  return lowercaseHex(sha256BytesSync(new TextEncoder().encode(value)));
}
