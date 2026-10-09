"use client";

import { Activity, ChevronRight, Clock, MessageSquare } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import {
  agentPresetAvatarUrl,
  normalizeAgentPresetRuntime,
  type AgentRegistrationSummary,
  type ObservabilityEvent,
  type SerializedAgentInstance,
  type SerializedAutomation,
  type SerializedChannel,
} from "@xmatrix/protocol";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatAutomationCadence, formatAutomationNext } from "@/components/pages/page-automation-format";

import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { useNow } from "./agent-work-intent";
import { channelTitle } from "./channel-links";
import { ListSkeleton } from "./content-skeleton";
import { IdentityAvatar } from "./identity-avatar";
import { MachineGlyph } from "./machine-glyph";
import { MachineLoadGlance } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import { ErrorNotice } from "@/components/ui/error-notice";
import { registrationActivity, registrationListed } from "./my-agents-registrations";
import { scheduleRunning } from "./schedules-model";
import { formatRelativeAge } from "./time-display";
import {
  ToolDetail, ToolDetailSection, ToolFact, ToolFacts, ToolList, ToolListGroup, ToolListRow, ToolPaperScroll, ToolSplit,
  useToolItem,
} from "./tool-split";
import { channelWorkInHand } from "./workspace-shell-chrome";
import type { MachineSummary } from "./workspace-shell-helpers";

/** Machine rows show at most this many runtimes; the rest are counted. */
const MACHINE_RUNTIMES_SHOWN = 3;
const UPCOMING_SHOWN = 5;

type RuntimeCount = { harness: string; working: number };

/**
 * Status: the Space at work. Its list is what is happening now, ordered by
 * whether it needs you: what is stuck, who works on what, and what runs next.
 * The paper beside it is the overview at a glance until a row is chosen; on a
 * phone the overview leads the list.
 */
export function StatusView({
  spaceId,
  token,
  machines,
  channels,
  events,
  automations,
  onOpenAgents,
  onOpenMachine,
  onOpenMachines,
  onOpenSchedule,
  onOpenSchedules,
  onOpenConversation,
  onOpenTrace,
}: {
  spaceId: string | null;
  token: string | undefined;
  machines: MachineSummary[];
  channels: readonly SerializedChannel[];
  events: ObservabilityEvent[];
  automations: SerializedAutomation[];
  onOpenAgents: () => void;
  onOpenMachine: (machineId: string) => void;
  onOpenMachines: () => void;
  onOpenSchedule: (automationId: string) => void;
  onOpenSchedules: () => void;
  onOpenConversation: (channelId: string) => void;
  /** The Instance's live trace, as its avatar in the conversation opens it. */
  onOpenTrace: (member: string, instance: SerializedAgentInstance, channelId: string) => void;
}) {
  const [item, select] = useToolItem();
  const ready = Boolean(spaceId && token);
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", ready, { live: true });
  // Load samples and "seen" ages expire; re-read them between refreshes.
  const now = useNow(15_000);

  const registrations: Array<AgentRegistrationSummary & { harness: string }> = (catalog.data?.capabilities ?? [])
    .flatMap((group) => group.locations.filter(registrationListed).map((registration) => ({ ...registration, harness: group.harness })));
  // Working is what the conversation list shows as in progress: a live
  // process waiting for its next message runs but does not work.
  const inHand = useMemo(() => channels.flatMap((channel) => channelWorkInHand(channel, events)
    .map((work) => ({ ...work, channel }))), [channels, events]);
  const working = useMemo(() => new Set(inHand.map((work) => work.instance.id)), [inHand]);
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
    const working = catalog.data ? counts.reduce((sum, count) => sum + count.working, 0) : machine.activeRuns || 0;
    return { machine, counts, working, online: machine.status === "online" };
  }).sort((left, right) => Number(right.online) - Number(left.online) || right.working - left.working
    || left.machine.name.localeCompare(right.machine.name));
  const online = machineRows.filter((row) => row.online).length;
  const busy = machineRows.filter((row) => row.online && row.working > 0).length;

  const workingCount = catalog.data
    ? registrations.reduce((sum, registration) => sum + workingOf(registration), 0)
    : machineRows.reduce((sum, row) => sum + row.working, 0);

  const active = automations.filter(scheduleRunning);
  const upcoming = [...active].sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt))
    .slice(0, UPCOMING_SHOWN);

  const overview = (
    <>
      <header className="app-status-hero mb-8" data-testid="status-hero">
        <div className="flex items-baseline gap-2.5">
          <span className="text-6xl font-black leading-none tabular-nums" data-testid="status-working">{workingCount}</span>
          <span className="text-lg font-semibold">{workingCount === 1 ? "agent working" : "agents working"}</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="status-summary">
          {busy}/{online} machines busy · {active.length} {active.length === 1 ? "schedule" : "schedules"}
        </p>
      </header>

      <div className="space-y-8">
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

        <ToolDetailSection title={`Machines · ${online}/${machineRows.length} online`}
          action={<SeeAll label="All machines" onClick={onOpenMachines} />}>
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
                        <MachineGlyph os={machineOs(platformOf(machine))} className="size-4" />
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
    </>
  );

  // Where each working Instance runs and since when: its registration's live record.
  const runOf = (instanceId: string) => {
    for (const registration of registrations) {
      const run = registration.live?.running.find((candidate) => candidate.instanceId === instanceId);
      if (run) return { registration, since: run.since };
    }
    return null;
  };
  const work = inHand.map((entry) => {
    const run = runOf(entry.instance.id);
    return { ...entry, key: `work:${entry.instance.id}`, harness: run?.registration.harness,
      machineName: run?.registration.machineName, since: run?.since ?? entry.instance.connectedAt };
  }).sort((left, right) => Date.parse(left.since) - Date.parse(right.since));

  // What needs someone: a runtime that cannot take work, a machine that stopped answering.
  const stuckAgents = registrations.flatMap((registration) => {
    const activity = registrationActivity(registration, { conversationTitle: () => undefined, now });
    return activity.state === "attention" ? [{ registration, line: activity.line,
      key: `agent:${registration.harness}:${registration.key.machineId}` }] : [];
  });
  const stuckMachines = machineRows.filter((row) => row.online && row.machine.daemon?.unansweredSince)
    .map((row) => ({ ...row, key: `machine:${row.machine.id}` }));
  const attentionCount = stuckAgents.length + stuckMachines.length;

  const runtimeAvatar = (harness: string) => agentPresetAvatarUrl(normalizeAgentPresetRuntime(harness));
  const since = (value: string | undefined) => formatRelativeAge(value, now)?.replace(/ ago$/u, "");

  const list = (
    <ToolList title="Status">
      <div className="px-[var(--mobile-content-inset,1rem)] pt-3 pb-6 md:hidden">{overview}</div>
      {attentionCount > 0 && (
        <ToolListGroup title="Needs you" count={attentionCount}>
          {stuckAgents.map(({ registration, line, key }) => (
            <ToolListRow key={key} testId="status-attention-row" state="attention" selected={item === key}
              onSelect={() => select(key)} title={registration.harness}
              leading={<IdentityAvatar kind="agent" label={registration.harness} imageUrl={runtimeAvatar(registration.harness)}
                initials={registration.harness.slice(0, 2)} size="sm" showKindBadge={false} />}
              subtitle={`${registration.machineName} · ${line}`} />
          ))}
          {stuckMachines.map(({ machine, key }) => (
            <ToolListRow key={key} testId="status-attention-row" state="attention" selected={item === key}
              onSelect={() => select(key)} title={machine.name}
              leading={<span className="app-tool-state-icon" data-state="attention" aria-hidden="true">
                <MachineGlyph os={machineOs(platformOf(machine))} className="size-4" /></span>}
              subtitle={`Not responding · work waiting ${since(machine.daemon?.unansweredSince) ?? ""}`.trim()} />
          ))}
        </ToolListGroup>
      )}
      <ToolListGroup title="Working" count={work.length}>
        {work.length === 0 ? (
          <li className="px-5 py-2 text-sm text-muted-foreground">Nobody is working right now.</li>
        ) : work.map((entry) => (
          <ToolListRow key={entry.key} testId="status-work-row" state={entry.status} selected={item === entry.key}
            onSelect={() => select(entry.key)} title={channelTitle(entry.channel)}
            leading={<IdentityAvatar kind="agent" label={entry.instance.label} status={entry.instance.status}
              imageUrl={entry.harness ? runtimeAvatar(entry.harness) : entry.presence.avatarUrl}
              initials={entry.instance.label.slice(0, 2)} size="sm" showKindBadge={false} />}
            end={since(entry.since)}
            subtitle={[entry.status === "waiting" ? "Waiting" : null, entry.instance.label, entry.machineName]
              .filter(Boolean).join(" · ")} />
        ))}
      </ToolListGroup>
      {upcoming.length > 0 && (
        <ToolListGroup title="Next" count={active.length}>
          {upcoming.map((automation) => {
            const key = `schedule:${automation.id}`;
            return (
              <ToolListRow key={key} testId="status-next-row" selected={item === key} onSelect={() => select(key)}
                leading={<Clock className="size-4 text-muted-foreground" />} title={automation.name}
                end={formatAutomationNext(automation.nextRunAt).replace(/^next (?:run )?/u, "")} />
            );
          })}
        </ToolListGroup>
      )}
    </ToolList>
  );

  const back = { onBack: () => select(null), backLabel: "Status", context: "Status" };
  const chosenWork = work.find((entry) => entry.key === item);
  const chosenAgent = stuckAgents.find((entry) => entry.key === item);
  const chosenMachine = stuckMachines.find((entry) => entry.key === item);
  const chosenSchedule = upcoming.find((automation) => `schedule:${automation.id}` === item);
  let detail: ReactNode;
  if (chosenWork) {
    const { instance, channel } = chosenWork;
    detail = (
      <ToolDetail {...back} title={instance.label}
        status={`${chosenWork.status === "waiting" ? "Waiting" : "Working"} in #${channelTitle(channel)} · since ${since(chosenWork.since) ?? "now"}`}
        actions={<>
          <Button size="sm" variant="outline" onClick={() => onOpenTrace(chosenWork.member, instance, channel.id)}>
            <Activity /> Trace
          </Button>
          <Button size="sm" variant="outline" onClick={() => onOpenConversation(channel.id)}>
            <MessageSquare /> Conversation
          </Button>
        </>}>
        <ToolFacts>
          {chosenWork.harness && <ToolFact label="Runtime">{chosenWork.harness}</ToolFact>}
          {chosenWork.machineName && <ToolFact label="Machine">{chosenWork.machineName}</ToolFact>}
          <ToolFact label="Conversation">#{channelTitle(channel)}</ToolFact>
          {instance.gitBranch && <ToolFact label="Branch"><span className="font-mono text-xs">{instance.gitBranch}</span></ToolFact>}
        </ToolFacts>
      </ToolDetail>
    );
  } else if (chosenAgent) {
    const { registration, line } = chosenAgent;
    detail = (
      <ToolDetail {...back} title={registration.harness} status={line}
        actions={<Button size="sm" variant="outline" onClick={onOpenAgents}>All agents</Button>}>
        <ToolFacts>
          <ToolFact label="Machine">{registration.machineName}</ToolFact>
          <ToolFact label="State">{line}</ToolFact>
        </ToolFacts>
      </ToolDetail>
    );
  } else if (chosenMachine) {
    const { machine } = chosenMachine;
    detail = (
      <ToolDetail {...back} title={machine.name}
        status={`Not responding · work waiting since ${since(machine.daemon?.unansweredSince) ?? "now"}`}
        actions={<Button size="sm" variant="outline" onClick={() => onOpenMachine(machine.id)}>Open machine</Button>}>
        <MachineLoadGlance machine={machine} now={now} />
      </ToolDetail>
    );
  } else if (chosenSchedule) {
    const scheduleChannel = channels.find((channel) => channel.id === chosenSchedule.channelId);
    detail = (
      <ToolDetail {...back} title={chosenSchedule.name}
        status={formatAutomationNext(chosenSchedule.nextRunAt)}
        actions={<>
          <Button size="sm" variant="outline" onClick={() => onOpenSchedule(chosenSchedule.id)}>
            <Clock /> Schedule
          </Button>
          <Button size="sm" variant="outline" onClick={() => onOpenConversation(chosenSchedule.channelId)}>
            <MessageSquare /> Conversation
          </Button>
        </>}>
        <ToolFacts>
          <ToolFact label="Runs">{formatAutomationCadence(chosenSchedule.intervalMinutes)}</ToolFact>
          {scheduleChannel && <ToolFact label="Conversation">#{channelTitle(scheduleChannel)}</ToolFact>}
        </ToolFacts>
      </ToolDetail>
    );
  } else {
    detail = <ToolPaperScroll>{overview}</ToolPaperScroll>;
  }

  const chosen = Boolean(chosenWork || chosenAgent || chosenMachine || chosenSchedule);
  return <ToolSplit label="Status" open={chosen} list={list} detail={detail} />;
}

function platformOf(machine: MachineSummary): string | undefined {
  const platform = machine.daemon?.metadata?.platform;
  return typeof platform === "string" ? platform : undefined;
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
