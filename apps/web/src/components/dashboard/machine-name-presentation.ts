import type { AgentRegistrationSummary } from "@xmatrix/protocol";
import type { TimelineItem } from "./workspace-shell-message-model";
import { machineBusyPercent, machineGlanceReadings, machineLoadReadings } from "./machine-load";
import type { StatusChip } from "./workspace-shell-domain-types";

/** Old messages have no registration snapshot. Resolve only their exact
 * Instance in the reader's authorized catalog, never a name or Channel slot. */
export function messageMachineIdentity(registrations: readonly AgentRegistrationSummary[],
  message: Pick<TimelineItem, "senderMachineId" | "senderMachineOwnerUserId" | "senderInstanceId">): { machineId: string; ownerUserId?: string } | undefined {
  if (message.senderMachineId) return { machineId: message.senderMachineId, ownerUserId: message.senderMachineOwnerUserId };
  if (!message.senderInstanceId) return undefined;
  const matches = registrations.filter(row => row.live?.running.some(
    instance => instance.instanceId === message.senderInstanceId));
  const machines = new Set(matches.map(row => JSON.stringify([row.key.ownerUserId, row.key.machineId])));
  if (machines.size !== 1) return undefined;
  return { machineId: matches[0].key.machineId, ownerUserId: matches[0].key.ownerUserId };
}


function machineRows(registrations: readonly AgentRegistrationSummary[],
  machineId: string | undefined, ownerUserId?: string): AgentRegistrationSummary[] {
  if (!machineId) return [];
  const matches = registrations.filter(row => row.key.machineId === machineId &&
    (ownerUserId === undefined || row.key.ownerUserId === ownerUserId));
  // Only one owner's Machine is one Machine.
  return new Set(matches.map(row => row.key.ownerUserId)).size === 1 ? matches : [];
}

/** Names are read from the authorized catalog by exact owner and Machine scope. */
export function registrationMachineName(registrations: readonly AgentRegistrationSummary[],
  machineId: string | undefined, ownerUserId?: string): string | undefined {
  const names = new Set(machineRows(registrations, machineId, ownerUserId).map(row => row.machineName.trim()).filter(Boolean));
  return names.size === 1 ? [...names][0] : undefined;
}

/** How busy that Machine is now, from its connected daemon's load sample, for its tag. */
export function registrationMachineBusy(registrations: readonly AgentRegistrationSummary[],
  machineId: string | undefined, ownerUserId?: string): StatusChip["busy"] {
  const resources = machineRows(registrations, machineId, ownerUserId)
    .map(row => row.live?.machine.online ? row.live.machine.resources : undefined).find(Boolean);
  const readings = machineLoadReadings(resources);
  const percent = machineBusyPercent(readings);
  if (percent === undefined) return undefined;
  return { percent, glance: machineGlanceReadings(readings) };
}

export type MachineLinkTarget = { machineId: string; ownerUserId?: string };

/** Whether a Machine tag's `target` is one of the reader's openable `machines`:
 * the exact id, and the same owner when both sides name one. */
export function machineLinkable(machines: readonly MachineLinkTarget[], target: MachineLinkTarget | undefined): boolean {
  if (!target?.machineId) return false;
  return machines.some((machine) => machine.machineId === target.machineId
    && (!target.ownerUserId || !machine.ownerUserId || machine.ownerUserId === target.ownerUserId));
}
