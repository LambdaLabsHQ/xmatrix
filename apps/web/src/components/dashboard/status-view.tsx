"use client";

import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import {
  agentPresetAvatarUrl,
  normalizeAgentPresetRuntime,
  type AgentRegistrationSummary,
  type ObservabilityEvent,
  type SerializedAutomation,
  type SerializedChannel,
} from "@xmatrix/protocol";

import { cn } from "@/lib/utils";
import { ErrorNotice } from "@/components/ui/error-notice";

import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { AgentListGroups, agentListGroups } from "./agent-list-groups";
import { useNow } from "./agent-work-intent";
import { channelTitle } from "./channel-links";
import { ListSkeleton } from "./content-skeleton";
import { IdentityAvatar } from "./identity-avatar";
import { MachineListRow, machinePlatform, machineStateLine, machinesWithHostsFirst } from "./machine-list-row";
import { registrationActivity, registrationListed } from "./my-agents-registrations";
import { ScheduleListGroups, useScheduleWhere } from "./schedule-list-groups";
import { scheduleRunning, type ScheduleState } from "./schedules-model";
import { ToolDetailSection, ToolList, ToolListDense, ToolListGroup, ToolPaperScroll, ToolSplit } from "./tool-split";
import { channelWorkInHand } from "./workspace-shell-chrome";
import type { MachineSummary } from "./workspace-shell-helpers";

/** Status lists every group of schedules among other things, so each says it is schedules. */
const SCHEDULE_TITLES: Record<ScheduleState, string> = {
  attention: "Schedules needing attention",
  running: "Schedules",
  paused: "Paused schedules",
};

/**
 * Status: the Space at work. Its list is the Agents, Machines and Schedules
 * lists one after another, a line per row, so the whole Space fits on one
 * screen; a row opens in its own destination. The paper beside it counts who
 * is working; on a phone that count leads the list.
 */
export function StatusView({
  spaceId,
  token,
  currentUserId,
  machines,
  channels,
  events,
  automations,
  executionEnabled,
  onOpenAgent,
  onOpenAgents,
  onOpenMachine,
  onOpenMachines,
  onOpenSchedule,
}: {
  spaceId: string | null;
  token: string | undefined;
  currentUserId: string;
  machines: MachineSummary[];
  channels: readonly SerializedChannel[];
  events: ObservabilityEvent[];
  automations: SerializedAutomation[];
  executionEnabled: boolean | null;
  onOpenAgent: (registrationId: string) => void;
  onOpenAgents: () => void;
  onOpenMachine: (machineId: string) => void;
  onOpenMachines: () => void;
  onOpenSchedule: (automationId: string) => void;
}) {
  const ready = Boolean(spaceId && token);
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", ready, { live: true });
  const where = useScheduleWhere(spaceId, token ?? "", channels);
  // Load samples and "seen" ages expire; re-read them between refreshes.
  const now = useNow(15_000);

  const conversationTitle = (channelId: string) => {
    const channel = channels.find((candidate) => candidate.id === channelId);
    return channel ? channelTitle(channel) : undefined;
  };
  const groups = agentListGroups(catalog.data, { conversationTitle, now });
  const registrations: Array<AgentRegistrationSummary & { harness: string }> = (catalog.data?.capabilities ?? [])
    .flatMap((group) => group.locations.filter(registrationListed).map((registration) => ({ ...registration, harness: group.harness })));
  // Working is what the conversation list shows as in progress: a live
  // process waiting for its next message runs but does not work.
  const working = useMemo(() => new Set(channels.flatMap((channel) => channelWorkInHand(channel, events)
    .map((work) => work.instance.id))), [channels, events]);
  const workingOf = (registration: AgentRegistrationSummary) =>
    registration.live?.running.filter((instance) => working.has(instance.instanceId)).length ?? 0;

  const runtimes = (catalog.data?.capabilities ?? []).map((group) => {
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

  const online = machines.filter((machine) => machine.status === "online");
  // Active Runs count idle processes too; read them only until the catalog says who works.
  const workingCount = catalog.data
    ? registrations.reduce((sum, registration) => sum + workingOf(registration), 0)
    : online.reduce((sum, machine) => sum + (machine.activeRuns || 0), 0);
  const busy = catalog.data
    ? new Set(registrations.filter((registration) => workingOf(registration) > 0)
      .map((registration) => registration.key.machineId)).size
    : online.filter((machine) => (machine.activeRuns || 0) > 0).length;
  const scheduled = automations.filter(scheduleRunning).length;

  const overview = (
    <>
      <header className="app-status-hero mb-8" data-testid="status-hero">
        <div className="flex items-baseline gap-2.5">
          <span className="text-6xl font-black leading-none tabular-nums" data-testid="status-working">{workingCount}</span>
          <span className="text-lg font-semibold">{workingCount === 1 ? "agent working" : "agents working"}</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="status-summary">
          {busy}/{online.length} machines busy · {scheduled} {scheduled === 1 ? "schedule" : "schedules"}
        </p>
      </header>

      <ToolDetailSection title="Agents" action={<SeeAll label="All agents" onClick={onOpenAgents} />}>
        {catalog.isError ? (
          <ErrorNotice error={catalog.error} action="Couldn't load the agent list" onRetry={() => void catalog.refetch()} />
        ) : !catalog.data && ready ? (
          <ListSkeleton label="Loading agents" rows={1} />
        ) : runtimes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-6 gap-y-3 pt-1">
            {runtimes.map((runtime) => (
              <li key={runtime.harness}>
                <button type="button" onClick={onOpenAgents} data-testid="status-runtime"
                  title={runtimeLine(runtime)} aria-label={`${runtime.harness}: ${runtime.working} working, ${runtimeLine(runtime)}`}
                  className={cn("flex items-center gap-2", runtime.working === 0 && "opacity-50")}>
                  <IdentityAvatar kind="agent" label={runtime.harness}
                    imageUrl={agentPresetAvatarUrl(normalizeAgentPresetRuntime(runtime.harness))}
                    initials={runtime.harness.slice(0, 2)} size="sm" showKindBadge={false} className="shrink-0" />
                  <span className="text-xl font-black tabular-nums">{runtime.working}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ToolDetailSection>
    </>
  );

  const list = (
    <ToolList title="Status">
      <div className="px-[var(--mobile-content-inset,1rem)] pt-3 pb-6 md:hidden">{overview}</div>
      <ToolListDense>
        <AgentListGroups groups={groups} selectedId={null} currentUserId={currentUserId} onSelect={onOpenAgent} />
        {machines.length > 0 && (
          <ToolListGroup title="Machines" count={machines.length} onTitle={onOpenMachines} titleHint="All machines">
            {machinesWithHostsFirst(machines).map((machine) => {
              const host = machines.find((candidate) => candidate.machineId && candidate.machineId === machine.parentMachineId);
              return (
                <MachineListRow key={machine.id} machine={machine} name={machine.name}
                  platform={machinePlatform(machine)} online={machine.status === "online"} hosted={Boolean(host)}
                  subtitle={[host ? `WSL on ${host.name}` : null, machineStateLine(machine)].filter(Boolean).join(" · ")}
                  now={now} selected={false} onSelect={() => onOpenMachine(machine.id)} />
              );
            })}
          </ToolListGroup>
        )}
        <ScheduleListGroups automations={automations} executionEnabled={executionEnabled} where={where} now={now}
          selectedId={null} onSelect={onOpenSchedule} titles={SCHEDULE_TITLES} />
      </ToolListDense>
    </ToolList>
  );

  return <ToolSplit label="Status" open={false} list={list} detail={<ToolPaperScroll>{overview}</ToolPaperScroll>} />;
}

function SeeAll({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label}
      className="flex items-center gap-0.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
      See all <ChevronRight className="size-3.5" />
    </button>
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
