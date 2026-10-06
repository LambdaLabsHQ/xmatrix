import { createHash } from "node:crypto";

/** The historical FNV daemon id and its stable SHA successor. */
export function historicalDaemonIds(ownerUserId, machineId, hostId) {
  let hash = 0x811c9dc5;
  for (const character of `${ownerUserId}\0${machineId}\0${hostId}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  return {
    oldId: `daemon:${hash.toString(16).padStart(8, "0")}`,
    daemonId: `daemon:${createHash("sha256").update(`${ownerUserId}\0${machineId}`).digest("hex")}`,
  };
}
