"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { MachineGlyph } from "./machine-glyph";
import { MachineLoadGlance } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import { ToolListRow } from "./tool-split";
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

/** What a Machine is doing now: Agents running on it while online, when it was last seen once offline. */
export function machineStateLine(machine: MachineSummary): string | null {
  return machine.status === "online"
    ? machineUnresponsive(machine) ? "Not responding"
      : machine.activeRuns === undefined ? null
      : machine.activeRuns === 0 ? "Idle" : `${machine.activeRuns} ${machine.activeRuns === 1 ? "agent" : "agents"} running`
    : machine.lastSeenAt ? `Offline · seen ${relativeTime(machine.lastSeenAt)}` : "Offline";
}

/** A Machine as the Machines list shows it: its OS mark toned by state, its name, what it does, its load. */
export function MachineListRow({ machine, name, platform, online, hosted, subtitle, now, selected, shownBeside, onSelect }: {
  /** The Hub's record; the desktop's own machine has none until the Hub lists it. */
  machine: MachineSummary | null;
  name: string;
  platform: string | undefined;
  online: boolean;
  /** A WSL guest, indented under its host. */
  hosted?: boolean;
  subtitle: ReactNode;
  now: number;
  selected: boolean;
  shownBeside?: boolean;
  onSelect: () => void;
}) {
  const stalled = Boolean(machine && machineUnresponsive(machine));
  return (
    <ToolListRow testId="machine-row" selected={selected} shownBeside={shownBeside} onSelect={onSelect}
      leading={<span className={cn("app-tool-state-icon", hosted && "pl-4")}
        data-state={stalled ? "attention" : online ? "running" : "offline"}
        aria-label={`${name}: ${stalled ? "not responding" : online ? "online" : "offline"}`} role="img">
        <MachineGlyph os={machineOs(platform)} /></span>}
      trailing={machine && <MachineLoadGlance machine={machine} now={now} />}
      title={name}
      subtitle={subtitle} />
  );
}
