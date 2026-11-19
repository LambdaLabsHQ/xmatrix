"use client";

import { useMemo } from "react";
import {
  type AgentCapabilitySummary,
  type AgentRegistrationSummary,
  type ObservabilityEvent,
  type ChannelSnapshot,
} from "@xmatrix/protocol";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ui/error-notice";
import { statusInkClass } from "@/components/ui/status-tone";

import { ListSkeleton } from "./content-skeleton";
import { Face } from "./face";
import { MachineGlyph } from "./machine-glyph";
import { MachineLoadGlance } from "./machine-load-panel";
import { machinePlatform } from "./machine-list-row";
import { machineOs } from "./machine-os";
import { registrationActivity, registrationListed } from "./my-agents-registrations";
import { formatRelativeAge } from "./time-display";
import { ToolDetailSection } from "./tool-split";
import { channelWorkInHand } from "./workspace-shell-chrome";
import { useLiveChannels } from "./realtime-channels";
import type { MachineSummary } from "./workspace-shell-helpers";

/** Machine rows show at most this many runtimes; the rest are counted. */
const MACHINE_RUNTIMES_SHOWN = 3;

type RuntimeCount = { harness: string; working: number };

/** What the Space is doing now, counted once for the list and the overview beside it. */
export function useFleetStatus({ catalog, machines, channels, events, now }: {
  catalog: { capabilities: AgentCapabilitySummary[] } | undefined;
  machines: MachineSummary[];
  channels: readonly ChannelSnapshot[];
  events: ObservabilityEvent[];
  now: number;
}) {
  const registrations: Array<AgentRegistrationSummary & { harness: string }> = (catalog?.capabilities ?? [])
    .flatMap((group) => group.locations.filter(registrationListed).map((registration) => ({ ...registration, harness: group.harness })));
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

  const runtimes = (catalog?.capabilities ?? []).map((group) => {
    const locations = group.locations.filter(registrationListed);
    const states = locations.map((registration) => ({
      registration,
      state: registrationActivity(registration, { conversationTitle: () => undefined, now }).state,
    }));
    const working = locations.reduce((sum, registration) => sum + workingOf(registration), 0);
    const busyMachines = locations.filter((registration) => workingOf(registration) > 0).length;
    const ready = states.filter(({ registration, state }) => state === "running" && workingOf(registration) === 0).length;
    const blocked = states.filter(({ state }) => state === "attention").length;
    const offline = states.filter(({ state }) => state === "offline" || state === "paused").length;
    return { harness: group.harness, working, busyMachines, ready, blocked, offline, total: locations.length };
  }).filter((runtime) => runtime.total > 0)
    .sort((left, right) => right.working - left.working || left.harness.localeCompare(right.harness));

  // A machine's runtimes are the registrations on it that are working now.
  const runtimesOn = (machine: MachineSummary): RuntimeCount[] => registrations
    .filter((registration) => machine.machineId ? registration.key.machineId === machine.machineId
      : registration.machineName === machine.name)
    .reduce<RuntimeCount[]>((counts, registration) => {
      const working = workingOf(registration);
      if (!working) return counts;
      const existing = counts.find((count) => count.harness === registration.harness);
      if (existing) existing.working += working;
      else counts.push({ harness: registration.harness, working });
      return counts;
    }, [])
    .sort((left, right) => right.working - left.working);

  const machineRows = machines.map((machine) => {
    const counts = runtimesOn(machine);
    // Active Runs count idle processes too; read them only until the catalog says who works.
    const working = catalog ? counts.reduce((sum, count) => sum + count.working, 0) : machine.activeRuns || 0;
    return { machine, counts, working, online: machine.status === "online" };
  }).sort((left, right) => Number(right.online) - Number(left.online) || right.working - left.working
    || left.machine.name.localeCompare(right.machine.name));
  const online = machineRows.filter((row) => row.online).length;
  const busy = machineRows.filter((row) => row.online && row.working > 0).length;

  const workingCount = catalog
    ? registrations.reduce((sum, registration) => sum + workingOf(registration), 0)
    : machineRows.reduce((sum, row) => sum + row.working, 0);
  return { runtimes, machineRows, online, busy, workingCount, workingInstanceIds: working };
}

export type FleetStatus = ReturnType<typeof useFleetStatus>;

/**
 * The overview: the Space at work at a glance. How many agents are working,
 * what each runtime does, and every machine with who works on it. A runtime
 * opens what is set on that agent, a machine opens its page.
 */
/** One line of the overview that opens what it names: an agent at work, or something waiting on its owner. */
export type FleetOverviewLine = { key: string; harness: string; title: string; line: string; onOpen: () => void };

export function FleetOverview({ status, attention, workingNow, unresponsive, loading, error, onRetry, now, onOpenHarness, onOpenMachine, onSetUpAgents }: {
  status: FleetStatus;
  /** What cannot take work until someone acts: signed out, out of quota, unconfirmed access, a machine not answering. */
  attention: FleetOverviewLine[];
  /** Each agent with work in hand and the conversation it is in. */
  workingNow: FleetOverviewLine[];
  /** Machines that read online but leave work unanswered. */
  unresponsive: Array<{ id: string; name: string }>;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
  onOpenHarness: (harness: string) => void;
  onOpenMachine: (machineId: string) => void;
  /** Where agents come from, offered while the Space has none. */
  onSetUpAgents: () => void;
}) {
  const { runtimes, machineRows, online, busy, workingCount } = status;
  return (
    <>
      <header className="app-status-hero mb-8" data-testid="status-hero">
        <div className="flex items-baseline gap-2.5">
          <span className="text-6xl font-black leading-none tabular-nums" data-testid="status-working">{workingCount}</span>
          <span className="text-lg font-semibold">{workingCount === 1 ? "agent working" : "agents working"}</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="status-summary">
          {busy}/{online} machines busy
        </p>
      </header>

      <div className="space-y-8">
        {attention.length + unresponsive.length > 0 && (
          <ToolDetailSection title={`Needs attention · ${attention.length + unresponsive.length}`}>
            <ul className="app-tool-lines">
              {unresponsive.map((machine) => (
                <li key={machine.id}>
                  <button type="button" onClick={() => onOpenMachine(machine.id)} data-testid="status-attention"
                    className="flex w-full min-w-0 items-center gap-3 py-2 text-left text-sm">
                    <span className="min-w-0 truncate font-semibold">{machine.name}</span>
                    <span className={cn("ml-auto shrink-0 text-xs", statusInkClass("attention"))}>Not responding</span>
                  </button>
                </li>
              ))}
            </ul>
            <OverviewLines lines={attention} testId="status-attention" tone="attention" />
          </ToolDetailSection>
        )}
        {workingNow.length > 0 && (
          <ToolDetailSection title="Working now">
            <OverviewLines lines={workingNow} testId="status-working-now" tone="running" />
          </ToolDetailSection>
        )}
        <ToolDetailSection title="Agents">
          {error ? (
            <ErrorNotice error={error} action="Couldn't load the agent list" onRetry={onRetry} />
          ) : loading ? (
            <ListSkeleton label="Loading agents" rows={1} className="[--app-list-row-end:0px] [--app-list-row-start:0px]" />
          ) : runtimes.length === 0 ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>No agents yet.</p>
              <Button size="sm" variant="outline" onClick={onSetUpAgents}>Bring agents in</Button>
            </div>
          ) : (
            <ul className="flex flex-wrap gap-x-6 gap-y-3 pt-1">
              {runtimes.map((runtime) => (
                <li key={runtime.harness}>
                  <button type="button" onClick={() => onOpenHarness(runtime.harness)} data-testid="status-runtime"
                    title={runtimeLine(runtime)} aria-label={`${runtime.harness}: ${runtime.working} working, ${runtimeLine(runtime)}`}
                    className={cn("flex items-center gap-2", runtime.working === 0 && "opacity-50")}>
                    <Face of={{ kind: "agent", name: runtime.harness, harness: runtime.harness }} size="sm"
                      showKindBadge={false} className="shrink-0" />
                    <span className="text-xl font-black tabular-nums">{runtime.working}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ToolDetailSection>

        <ToolDetailSection title={`Machines · ${online}/${machineRows.length} online`}>
          {machineRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No machines registered.</p>
          ) : (
            <ul className="app-tool-lines">
              {machineRows.map(({ machine, counts, working: machineWorking, online: up }) => {
                const seen = formatRelativeAge(machine.lastSeenAt, now);
                return (
                  <li key={machine.id}>
                    <button type="button" onClick={() => onOpenMachine(machine.id)} data-testid="status-machine-row"
                      className={cn("flex w-full min-w-0 items-center gap-3 py-2.5 text-left", !up && "opacity-50")}>
                      <span className="app-tool-state-icon" data-state={up ? "running" : "offline"} aria-hidden="true">
                        <MachineGlyph os={machineOs(machinePlatform(machine))} className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{machine.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {!up ? (seen ? `Offline · seen ${seen}` : "Offline")
                            : machineWorking > 0 ? `${machineWorking} working` : "Idle"}
                        </span>
                      </span>
                      {up && counts.length > 0 && <RuntimeStack counts={counts} />}
                      <span className="hidden sm:block"><MachineLoadGlance machine={machine} now={now} /></span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ToolDetailSection>

      </div>
    </>
  );
}

function OverviewLines({ lines, testId, tone }: { lines: FleetOverviewLine[]; testId: string; tone: "attention" | "running" }) {
  return (
    <ul className="app-tool-lines">
      {lines.map((item) => (
        <li key={item.key}>
          <button type="button" onClick={item.onOpen} data-testid={testId}
            className="flex w-full min-w-0 items-center gap-3 py-2 text-left text-sm">
            <Face of={{ kind: "agent", name: item.harness, harness: item.harness }} size="xs" showKindBadge={false} className="shrink-0" />
            <span className="min-w-0 shrink-0 truncate font-semibold">{item.title}</span>
            <span className={cn("ml-auto min-w-0 truncate text-xs", tone === "attention" ? statusInkClass("attention") : "text-muted-foreground")}>
              {item.line}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

type RuntimeTotals = { working: number; busyMachines: number; ready: number; blocked: number; offline: number; total: number };

/** What a runtime's locations are doing, beyond the count of its working agents. */
function runtimeLine(runtime: RuntimeTotals): string {
  return [
    runtime.working > 0 ? `on ${runtime.busyMachines} ${runtime.busyMachines === 1 ? "machine" : "machines"}` : null,
    runtime.ready > 0 ? `${runtime.ready} ready` : null,
    runtime.blocked > 0 ? `${runtime.blocked} out of quota` : null,
    runtime.offline > 0 ? `${runtime.offline} offline` : null,
  ].filter(Boolean).join(" · ") || `${runtime.total} ${runtime.total === 1 ? "machine" : "machines"}`;
}

/** The runtimes working on a machine: each one's face and how many of it, the rest counted. */
function RuntimeStack({ counts }: { counts: RuntimeCount[] }) {
  const shown = counts.slice(0, MACHINE_RUNTIMES_SHOWN);
  const rest = counts.length - shown.length;
  return (
    <span className="flex shrink-0 items-center gap-2.5"
      aria-label={counts.map((count) => `${count.harness} ${count.working}`).join(", ")} role="img">
      {shown.map((count) => (
        <span key={count.harness} className="flex items-center gap-1" aria-hidden="true">
          <Face of={{ kind: "agent", name: count.harness, harness: count.harness }} size="xs" showKindBadge={false} />
          <span className="text-sm font-semibold tabular-nums">{count.working}</span>
        </span>
      ))}
      {rest > 0 && <span className="text-xs font-semibold text-muted-foreground" aria-hidden="true">+{rest}</span>}
    </span>
  );
}
