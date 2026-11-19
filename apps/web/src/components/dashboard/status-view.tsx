"use client";

import { ChevronRight } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import {
  type AgentCapabilitySummary,
  type AgentRegistrationSummary,
  type ObservabilityEvent,
  type ChannelSnapshot,
} from "@xmatrix/protocol";

import { cn } from "@/lib/utils";
import { statusInkClass } from "@/components/ui/status-tone";

import { Face } from "./face";
import { MachineGlyph } from "./machine-glyph";
import { registrationListed } from "./my-agents-registrations";
import { ToolDetailSection } from "./tool-split";
import { channelWorkInHand } from "./workspace-shell-chrome";
import { useLiveChannels } from "./realtime-channels";
import type { MachineSummary } from "./workspace-shell-helpers";

/** What the Space is doing now, counted once for the list and the overview beside it. */
export function useFleetStatus({ catalog, machines, channels, events }: {
  catalog: { capabilities: AgentCapabilitySummary[] } | undefined;
  machines: MachineSummary[];
  channels: readonly ChannelSnapshot[];
  events: ObservabilityEvent[];
}) {
  // Working is an Instance with work in hand in some conversation: a live
  // process waiting for its next message runs but does not work.
  // The list copies hold no Instances: work in hand is read from the live Channels.
  const liveChannels = useLiveChannels();
  const working = useMemo(() => {
    const listed = new Set(channels.map((channel) => channel.id));
    return new Set(liveChannels.filter((channel) => listed.has(channel.id)).flatMap((channel) =>
      channelWorkInHand(channel, events).map((work) => work.instance.id)));
  }, [channels, liveChannels, events]);
  const workingOf = (registration: AgentRegistrationSummary) =>
    registration.live?.running.filter((instance) => working.has(instance.instanceId)).length ?? 0;

  // What works on a Machine is the work in hand of the registrations on it.
  const registrations = (catalog?.capabilities ?? []).flatMap((group) => group.locations.filter(registrationListed));
  const workingOn = (machine: MachineSummary): number | undefined => {
    // Active Runs count idle processes too; without the catalog nothing says who works.
    if (!catalog) return undefined;
    return registrations.filter((registration) => machine.machineId ? registration.key.machineId === machine.machineId
      : registration.machineName === machine.name).reduce((sum, registration) => sum + workingOf(registration), 0);
  };
  const up = machines.filter((machine) => machine.status === "online");
  const busy = up.filter((machine) => (workingOn(machine) ?? machine.activeRuns ?? 0) > 0).length;
  const workingCount = catalog ? registrations.reduce((sum, registration) => sum + workingOf(registration), 0)
    : up.reduce((sum, machine) => sum + (machine.activeRuns ?? 0), 0);
  return { online: up.length, machineCount: machines.length, busy, workingCount, workingInstanceIds: working, workingOn };
}

export type FleetStatus = ReturnType<typeof useFleetStatus>;

/** One line of the overview that opens what it names: something waiting on its owner. */
export type FleetOverviewLine = {
  key: string;
  /** The agent it is about; a line about a Machine alone has none. */
  harness?: string;
  title: string;
  line: string;
  onOpen: () => void;
};

/**
 * The head of the Agents destination: how many agents are working and what
 * waits on a person. What follows it says each machine and agent once: the
 * matrix on a desktop, the agents across their machines above the list on a
 * phone.
 */
export function FleetOverview({ title = "Agents", status, attention, note, children }: {
  title?: string;
  status: FleetStatus;
  /** Said after the count's own line: what waits on a person, where no list of it follows. */
  note?: ReactNode;
  /** What cannot take work until someone acts: signed out, out of quota, unconfirmed access, a machine not answering. */
  attention: FleetOverviewLine[];
  children?: ReactNode;
}) {
  const { online, busy, workingCount } = status;
  return (
    <>
      <header className="app-status-hero mb-5" data-testid="status-hero">
        <h1 className="text-2xl font-black tracking-[-0.02em] text-foreground">{title}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          <span className={cn("tabular-nums", workingCount > 0 ? "font-semibold text-foreground" : "font-medium text-foreground/80")}
            data-testid="status-working">{workingCount}</span>{" "}
          <span className={workingCount > 0 ? "font-medium text-foreground" : undefined}>
            {workingCount === 1 ? "agent working" : "agents working"}
          </span>
          {workingCount > 0 && " "}
          <span data-testid="status-summary">
            {workingCount > 0 ? `on ${busy} ${busy === 1 ? "machine" : "machines"}`
              : online > 0 ? null : " · No machine online"}
            {note}
          </span>
        </p>
      </header>

      <div className="space-y-6">
        {attention.length > 0 && (
          <ToolDetailSection title={`Needs attention · ${attention.length}`}>
            <ul className="app-tool-lines">
              {attention.map((item) => (
                <li key={item.key}>
                  <button type="button" onClick={item.onOpen} data-testid="status-attention"
                    className="flex w-full min-w-0 items-center gap-3 py-2 text-left text-sm">
                    {item.harness
                      ? <Face of={{ kind: "agent", name: item.harness, harness: item.harness }} size="xs" showKindBadge={false} className="shrink-0" />
                      : <span className="app-tool-state-icon flex size-5 shrink-0 items-center justify-center" data-state="attention" aria-hidden="true">
                        <MachineGlyph os="unknown" className="size-4" /></span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{item.title}</span>
                      <span className={cn("block truncate text-xs", statusInkClass("attention"))}>{item.line}</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </ToolDetailSection>
        )}
        {children}
      </div>
    </>
  );
}

/** One agent over every machine it runs on: how many of it work, on how many machines, and what the rest are doing. */
export type FleetRuntime = { harness: string; working: number; busyMachines: number; ready: number; blocked: number; offline: number; total: number };

/** What a runtime's locations are doing, beyond the count of its working agents. */
export function runtimeLine(runtime: FleetRuntime): string {
  return [
    runtime.working > 0 ? `on ${runtime.busyMachines} ${runtime.busyMachines === 1 ? "machine" : "machines"}` : null,
    runtime.ready > 0 ? `${runtime.ready} ready` : null,
    runtime.blocked > 0 ? `${runtime.blocked} ${runtime.blocked === 1 ? "needs" : "need"} attention` : null,
    runtime.offline > 0 ? `${runtime.offline} offline` : null,
  ].filter(Boolean).join(" · ") || `${runtime.total} ${runtime.total === 1 ? "machine" : "machines"}`;
}
