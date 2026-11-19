"use client";

import type { MachineSummary } from "./workspace-shell-helpers";
import { relativeTime } from "./workspace-shell-recovered";

/** A WSL Machine is listed right after its Windows host. */
export function machinesWithHostsFirst(machines: MachineSummary[]): MachineSummary[] {
  const hosts = new Set(machines.map((machine) => machine.machineId).filter(Boolean));
  const hosted = (machine: MachineSummary) => Boolean(machine.parentMachineId && hosts.has(machine.parentMachineId));
  return machines.filter((machine) => !hosted(machine)).flatMap((machine) => [machine,
    ...machines.filter((child) => hosted(child) && child.parentMachineId === machine.machineId)]);
}

/** The OS a Machine's daemon reports; a Machine without one shows the generic mark. */
export function machinePlatform(machine: MachineSummary): string | undefined {
  const platform = machine.daemon?.metadata?.platform;
  return typeof platform === "string" ? platform : undefined;
}

/** "Online" follows connection events only; work it left unanswered says it is not actually responding. */
export function machineUnresponsive(machine: MachineSummary): boolean {
  return machine.status === "online" && Boolean(machine.daemon?.unansweredSince);
}

/**
 * What a Machine is doing now: how many agents on it have work in hand while
 * online, when it was last seen once offline. `working` is that count where
 * the agent list is known; a live process waiting for a message is not work.
 */
export function machineStateLine(machine: MachineSummary, working: number | undefined): string | null {
  return machine.status === "online"
    ? machineUnresponsive(machine) ? "Not responding"
      : working === undefined ? null
      : working === 0 ? "Idle" : `${working} working`
    : machine.lastSeenAt ? `Offline · seen ${relativeTime(machine.lastSeenAt)}` : "Offline";
}
