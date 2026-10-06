"use client";

import { ChevronRight } from "lucide-react";
import {
  agentPresetAvatarUrl,
  normalizeAgentPresetRuntime,
  type AgentRegistrationSummary,
  type SerializedAutomation,
} from "@xmatrix/protocol";

import { cn } from "@/lib/utils";
import { formatAutomationNext } from "@/components/pages/page-automation-format";

import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { useNow } from "./agent-work-intent";
import { ListSkeleton } from "./content-skeleton";
import { IdentityAvatar } from "./identity-avatar";
import { MachineGlyph } from "./machine-glyph";
import { MachineLoadGlance } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import { registrationActivity, registrationCatalogErrorText, registrationListed } from "./my-agents-registrations";
import { scheduleRunning } from "./schedules-model";
import { formatRelativeAge } from "./time-display";
import { ToolDetailSection, ToolPaperScroll } from "./tool-split";
import type { MachineSummary } from "./workspace-shell-helpers";

/** Machine rows show at most this many runtimes; the rest are counted. */
const MACHINE_RUNTIMES_SHOWN = 3;
const UPCOMING_SHOWN = 5;

type RuntimeCount = { harness: string; working: number };

/**
 * Status: the whole Space at work, read at a glance. How many agents are
 * working now, what each runtime is doing, what runs next, and every machine
 * with its load and who works on it. Rows grow downward only, so the page
 * holds however many machines and runtimes a Space has.
 */
export function StatusView({
  spaceId,
  token,
  machines,
  automations,
  onOpenAgents,
  onOpenMachine,
  onOpenMachines,
  onOpenSchedule,
  onOpenSchedules,
}: {
  spaceId: string | null;
  token: string | undefined;
  machines: MachineSummary[];
  automations: SerializedAutomation[];
  onOpenAgents: () => void;
  onOpenMachine: (machineId: string) => void;
  onOpenMachines: () => void;
  onOpenSchedule: (automationId: string) => void;
  onOpenSchedules: () => void;
}) {
  const ready = Boolean(spaceId && token);
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", ready, { live: true });
  // Load samples and "seen" ages expire; re-read them between refreshes.
  const now = useNow(15_000);

  const registrations: Array<AgentRegistrationSummary & { harness: string }> = (catalog.data?.capabilities ?? [])
    .flatMap((group) => group.locations.filter(registrationListed).map((registration) => ({ ...registration, harness: group.harness })));
  const workingOf = (registration: AgentRegistrationSummary) => registration.live?.running.length ?? 0;

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
    const working = counts.reduce((sum, count) => sum + count.working, 0) || machine.activeRuns || 0;
    return { machine, counts, working, online: machine.status === "online" };
  }).sort((left, right) => Number(right.online) - Number(left.online) || right.working - left.working
    || left.machine.name.localeCompare(right.machine.name));
  const online = machineRows.filter((row) => row.online).length;
  const busy = machineRows.filter((row) => row.online && row.working > 0).length;

  const working = catalog.data
    ? registrations.reduce((sum, registration) => sum + workingOf(registration), 0)
    : machineRows.reduce((sum, row) => sum + row.working, 0);

  const active = automations.filter(scheduleRunning);
  const upcoming = [...active].sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt))
    .slice(0, UPCOMING_SHOWN);

  return (
    <ToolPaperScroll>
      <header className="app-status-hero mb-8" data-testid="status-hero">
        <div className="flex items-baseline gap-2.5">
          <span className="text-6xl font-black leading-none tabular-nums" data-testid="status-working">{working}</span>
          <span className="text-lg font-semibold">{working === 1 ? "agent working" : "agents working"}</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="status-summary">
          {busy}/{online} machines busy · {active.length} {active.length === 1 ? "schedule" : "schedules"}
        </p>
      </header>

      <div className="space-y-8">
        <ToolDetailSection title="Agents" action={<SeeAll label="All agents" onClick={onOpenAgents} />}>
          {catalog.isError ? (
            <p role="alert" className="text-sm text-destructive">{registrationCatalogErrorText(catalog.error)}</p>
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

        <ToolDetailSection title={`Machines · ${online}/${machineRows.length} online`}
          action={<SeeAll label="All machines" onClick={onOpenMachines} />}>
          {machineRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No machines registered.</p>
          ) : (
            <ul className="app-tool-lines">
              {machineRows.map(({ machine, counts, working: machineWorking, online: up }) => {
                const seen = formatRelativeAge(machine.lastSeenAt, now);
                const platform = machine.daemon?.metadata?.platform;
                return (
                  <li key={machine.id}>
                    <button type="button" onClick={() => onOpenMachine(machine.id)} data-testid="status-machine-row"
                      className={cn("flex w-full min-w-0 items-center gap-3 py-2.5 text-left", !up && "opacity-50")}>
                      <span className="app-tool-state-icon" data-state={up ? "running" : "offline"} aria-hidden="true">
                        <MachineGlyph os={machineOs(typeof platform === "string" ? platform : undefined)} className="size-4" />
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
        <ToolDetailSection title="Schedules" action={<SeeAll label="All schedules" onClick={onOpenSchedules} />}>
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing runs on a schedule.</p>
          ) : (
            <ul className="app-tool-lines">
              {upcoming.map((automation) => (
                <li key={automation.id}>
                  <button type="button" onClick={() => onOpenSchedule(automation.id)} data-testid="status-schedule-row"
                    className="flex w-full min-w-0 items-baseline gap-3 py-2 text-left">
                    <span className="w-20 shrink-0 text-sm tabular-nums text-muted-foreground">
                      {formatAutomationNext(automation.nextRunAt).replace(/^next (?:run )?/u, "") || "unscheduled"}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{automation.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ToolDetailSection>

      </div>
    </ToolPaperScroll>
  );
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

/** The runtimes working on a machine: each one's face and how many of it, the rest counted. */
function RuntimeStack({ counts }: { counts: RuntimeCount[] }) {
  const shown = counts.slice(0, MACHINE_RUNTIMES_SHOWN);
  const rest = counts.length - shown.length;
  return (
    <span className="flex shrink-0 items-center gap-2.5"
      aria-label={counts.map((count) => `${count.harness} ${count.working}`).join(", ")} role="img">
      {shown.map((count) => (
        <span key={count.harness} className="flex items-center gap-1" aria-hidden="true">
          <IdentityAvatar kind="agent" label={count.harness}
            imageUrl={agentPresetAvatarUrl(normalizeAgentPresetRuntime(count.harness))}
            initials={count.harness.slice(0, 2)} size="xs" showKindBadge={false} />
          <span className="text-sm font-semibold tabular-nums">{count.working}</span>
        </span>
      ))}
      {rest > 0 && <span className="text-xs font-semibold text-muted-foreground" aria-hidden="true">+{rest}</span>}
    </span>
  );
}
