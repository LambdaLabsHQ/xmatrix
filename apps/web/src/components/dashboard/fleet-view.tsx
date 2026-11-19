"use client";

import { Activity, HardDrive, Plus, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentRegistrationSummary, ChannelSnapshot, ObservabilityEvent } from "@xmatrix/protocol";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ui/error-notice";
import { statusInkClass } from "@/components/ui/status-tone";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { cn } from "@/lib/utils";

import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { agentHarnessSelectionId, agentListGroups, type AgentListGroup } from "./agent-list-groups";
import { AGENT_USAGE_REFRESH_MS } from "./agent-quota-usage";
import { useNow } from "./agent-work-intent";
import { BringAgentsIn, RemoteMachineHint } from "./bring-agents-in";
import { channelTitle } from "./channel-links";
import { ContentSkeleton, ListSkeleton } from "./content-skeleton";
import { Face } from "./face";
import { signedOutRegistrations } from "./harness-sign-in";
import { ListSectionHeading } from "./list-section-heading";
import { MachineGlyph } from "./machine-glyph";
import { MachineListRow, machinePlatform, machineStateLine, machineUnresponsive } from "./machine-list-row";
import { MachineLoadGlanceBars } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import { AgentPaper } from "./my-agents-view";
import { SetupCardShell } from "./space-setup-card-chrome";
import { FleetOverview, useFleetStatus, type FleetOverviewLine, type FleetRuntime } from "./status-view";
import {
  LIST_ROW_CLASS_NAME, LIST_ROW_COPY_CLASS_NAME, LIST_ROW_LEADING_CLASS_NAME, LIST_ROW_LEADING_TWO_LINE_CLASS_NAME,
  LIST_ROW_META_CLASS_NAME, LIST_ROW_TITLE_CLASS_NAME, LIST_ROW_TITLE_LINE_CLASS_NAME,
} from "./row-frames";
import { ToolDetailSection, ToolList, ToolListRow, ToolPaperScroll, ToolSplit } from "./tool-split";
import { useViewSelection } from "./url-query-state";
import { useInstalledHarnesses } from "./use-installed-harnesses";
import {
  MachinePaper, THIS_MACHINE_SELECTION, ThisMachineTag, machineListModel, useMachineEdits, type ThisMachine,
} from "./workspace-fleet-views";
import type { MachineSummary } from "./workspace-shell-helpers";

/** The addresses of the one destination: the overview, an agent, a machine, this machine. */
export type FleetAddress = "status" | "agents" | "machines" | "local";

type AgentRow = AgentListGroup["rows"][number];

/** An agent is named by what people call it: the name the Space gave it, else its program's. */
function agentRowName(row: AgentRow): string {
  return row.machineInLine ? row.title : row.harness;
}

/**
 * Agents: every machine of the Space with the agents on it, in one list. The
 * paper beside it is whatever is chosen there: the overview (the Space at
 * work, and what waits on a person), a machine (the agents installed on it,
 * where one is added, signed in and turned on, then its load and settings),
 * or an agent on its machine (what it works on, its usage and settings). Each
 * has an address of its own, so a link to one still opens it.
 *
 * One count says who works, everywhere here: an Instance with work in hand.
 * A live process waiting for its next message is ready, not working.
 */
export function FleetView({
  view,
  spaceId,
  token,
  currentUserId,
  machines,
  channels,
  events,
  error,
  addsOnThisMachine,
  thisMachine,
  onChangeView,
  onOpenConversation,
}: {
  view: FleetAddress;
  spaceId: string | null;
  token: string | undefined;
  currentUserId: string;
  machines: MachineSummary[];
  channels: readonly ChannelSnapshot[];
  events: ObservabilityEvent[];
  error: string | null;
  /** The desktop app reports this machine's programs itself; a browser cannot. */
  addsOnThisMachine: boolean;
  thisMachine?: ThisMachine | null;
  onChangeView: (view: FleetAddress, selection?: string) => void;
  onOpenConversation: (channelId: string) => void;
}) {
  const ready = Boolean(spaceId && token);
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", ready, { live: true });
  const fleet = useInstalledHarnesses(spaceId, token, currentUserId);
  const copy = useOnboardingCopy(spaceId, token, currentUserId);
  // Ticks with the catalog refresh, so ages, load samples and reset countdowns keep moving.
  const now = useNow(AGENT_USAGE_REFRESH_MS);
  const status = useFleetStatus({ catalog: catalog.data, machines, channels, events });
  const [selectedAgentId, selectAgent] = useViewSelection("agents");
  const [selectedMachineId, selectMachine] = useViewSelection("machines");
  const edits = useMachineEdits();
  const onMachines = view === "machines" || view === "local";
  const model = machineListModel({ machines, thisMachine, edits,
    selectedMachineId: onMachines ? selectedMachineId : null,
    defaultMachineId: view === "local" ? THIS_MACHINE_SELECTION : undefined });

  const openAgent = (id: string) => view === "agents" ? selectAgent(id) : onChangeView("agents", id);
  const openMachine = (machine: MachineSummary | null) => {
    const id = !machine || model.isThis(machine) ? THIS_MACHINE_SELECTION : machine.id;
    if (onMachines) selectMachine(id);
    else onChangeView("machines", id);
  };

  const conversationTitle = (channelId: string) => {
    const channel = channels.find((candidate) => candidate.id === channelId);
    return channel ? channelTitle(channel) : undefined;
  };
  // What its machine reports of the program itself decides before anything else whether an agent can work:
  // one signed out, or too old for xMatrix to drive, is not ready whatever the Space says of it.
  const candidateId = (registration: AgentRegistrationSummary) => JSON.stringify([registration.key.spaceId,
    registration.key.ownerUserId, registration.key.machineId, registration.key.harness]);
  const tooOld = new Set(fleet.candidates.filter((candidate) => candidate.tooOld).map((candidate) => candidate.id));
  const listed = agentListGroups(catalog.data, { conversationTitle, now, working: status.workingInstanceIds });
  const signedOut = new Set(signedOutRegistrations(listed.flatMap((group) => group.rows.map((row) => row.registration)),
    currentUserId, fleet.daemons.data));
  const groups = listed.map((group) => ({ ...group, rows: group.rows.map((row) => {
    if (row.activity.state !== "running") return row;
    const blocked = tooOld.has(candidateId(row.registration)) ? "Too old for xMatrix: update it"
      : signedOut.has(row.registration) ? "Not signed in" : null;
    return blocked ? { ...row, activity: { ...row.activity, state: "attention" as const, line: blocked, brief: blocked, rank: 2, working: 0 } } : row;
  }) }));
  const rows = groups.flatMap((group) => group.rows)
    .sort((left, right) => left.activity.rank - right.activity.rank || agentRowName(left).localeCompare(agentRowName(right)));
  // Each agent across its machines, counted from the rows the list shows so the two never disagree.
  const runtimes: FleetRuntime[] = groups.map((group) => ({
    harness: group.harness,
    working: group.rows.reduce((sum, row) => sum + row.activity.working, 0),
    busyMachines: group.rows.filter((row) => row.activity.working > 0).length,
    ready: group.rows.filter((row) => row.activity.state === "running" && row.activity.working === 0).length,
    blocked: group.rows.filter((row) => row.activity.state === "attention").length,
    offline: group.rows.filter((row) => row.activity.state === "offline" || row.activity.state === "paused").length,
    total: group.rows.length,
  })).sort((left, right) => right.working - left.working || left.harness.localeCompare(right.harness));
  const loading = ready && !catalog.data && !catalog.isError;

  // Each agent is listed once, under its machine.
  const placed = new Set<string>();
  const agentsOn = (machine: MachineSummary | null): AgentRow[] => {
    const machineId = machine ? machine.machineId : thisMachine?.machineId;
    const found = rows.filter((row) => !placed.has(row.id) && (machineId ? row.registration.key.machineId === machineId
      : Boolean(machine) && row.registration.machineName === machine!.name));
    for (const row of found) placed.add(row.id);
    return found;
  };
  const machineSections = model.ordered.map((machine) => ({ machine, agents: agentsOn(machine) }));
  // An agent on a Machine this reader's list does not carry (a teammate's) is listed under that Machine's name.
  const elsewhere = rows.filter((row) => !placed.has(row.id)).reduce<Array<{ key: string; name: string; platform?: string; agents: AgentRow[] }>>(
    (sections, row) => {
      const key = row.registration.key.machineId;
      const section = sections.find((candidate) => candidate.key === key);
      if (section) section.agents.push(row);
      else sections.push({ key, name: row.registration.machineName, platform: row.registration.live?.machine.platform, agents: [row] });
      return sections;
    }, []);
  // The reader's own agents on a machine their list does not carry yet stay with their machines; the rest are teammates'.
  const ownedByReader = (section: (typeof elsewhere)[number]) =>
    section.agents.some((row) => row.registration.key.ownerUserId === currentUserId);
  const unlisted = elsewhere.filter(ownedByReader);
  const teammates = elsewhere.filter((section) => !ownedByReader(section));
  // Installed on the reader's own machines and not in this Space yet: turned on from the machine's page.
  const newCandidates = fleet.candidates.filter((candidate) => !candidate.registration);
  const machineOf = (registration: AgentRegistrationSummary) =>
    model.listed.find((machine) => machine.machineId === registration.key.machineId);
  const rowOn = (machine: MachineSummary, harness: string) => {
    const there = rows.filter((row) => row.harness === harness && row.registration.key.machineId === machine.machineId);
    return there.find((row) => row.registration.key.ownerUserId === currentUserId) ?? there[0];
  };
  /** What a row says under an agent's name; the usage bars beside it say the quota, so the line does not. */
  const rowLine = (row: AgentRow) => row.usage.length ? row.activity.brief : row.activity.line;

  const agentRow = (row: AgentRow, own: boolean) => {
    // Its machine's own row already says it is offline.
    const text = own && row.activity.state === "offline" ? null : rowLine(row);
    return (
      <ToolListRow key={row.id} testId="agent-row" state={row.activity.state} child
        selected={view === "agents" && row.id === selectedAgentId}
        onSelect={() => openAgent(row.id)}
        leading={<span className="app-tool-state-icon" data-state={row.activity.state} aria-hidden="true">
          <Face of={{ kind: "agent", name: row.harness, harness: row.harness }} size="xs" showKindBadge={false} /></span>}
        meter={<MachineLoadGlanceBars glance={row.usage}
          testId="agent-usage-glance" label={row.usage.map((reading) => reading.detail).join(", ")} />}
        title={agentRowName(row)}
        subtitle={[row.machineInLine ? row.harness : null, text].filter(Boolean).join(" · ") || undefined} />
    );
  };

  // What waits on a person, each line opening where it is dealt with.
  const placeOf = (row: AgentRow) => `${agentRowName(row)} on ${row.registration.machineName}`;
  const attention: FleetOverviewLine[] = [
    ...model.listed.filter(machineUnresponsive).map((machine) => ({ key: `machine:${machine.id}`,
      title: model.nameOf(machine), line: "Not responding", onOpen: () => onChangeView("machines", machine.id) })),
    ...rows.flatMap((row) => {
      const { registration } = row;
      const mine = registration.key.ownerUserId === currentUserId;
      const machine = machineOf(registration);
      const outdated = tooOld.has(candidateId(registration));
      const line = row.activity.state === "attention" ? row.activity.brief
        : mine && registration.state === "enabled" && registration.access && !registration.access.confirmed
          ? "Access on its machine not confirmed" : null;
      if (!line) return [];
      // A program is updated on its machine's page; everything else is on the agent's own.
      return [{ key: row.id, harness: row.harness, title: placeOf(row), line,
        onOpen: () => outdated && machine ? onChangeView("machines", machine.id) : onChangeView("agents", row.id) }];
    }),
  ];

  // An empty Space has nothing to overview: it shows where agents come from.
  const empty = Boolean(catalog.data) && rows.length === 0;
  const firstOwn = model.listed.find((machine) => newCandidates.some((candidate) => candidate.key.machineId === machine.machineId))
    ?? (thisMachine ? null : undefined);
  const setup = empty && newCandidates.length === 0 && !addsOnThisMachine;
  const overview: ReactNode = setup ? (
    <SetupCardShell>
      <BringAgentsIn spaceId={spaceId} token={token} userId={currentUserId} surface="agents" />
    </SetupCardShell>
  ) : (
    <FleetOverview status={status} runtimes={runtimes} attention={attention} loading={loading}
      error={catalog.isError ? catalog.error : null} onRetry={() => void catalog.refetch()}
      onOpenHarness={(harness) => onChangeView("agents", agentHarnessSelectionId(harness))}
      empty={empty ? <div className="space-y-3 text-sm text-muted-foreground" data-testid="fleet-empty">
        <p className="font-bold text-foreground">{newCandidates.length ? copy.enableInstalledTitle : copy.connectAgentsTitle}</p>
        <p>{copy.enableOrInstall}</p>
        {firstOwn !== undefined && <Button size="sm" variant="outline" onClick={() => openMachine(firstOwn)}>
          <Plus /> {firstOwn ? `Open ${model.nameOf(firstOwn)}` : `Open ${model.thisLabel}`}</Button>}
      </div> : undefined} />
  );
  const addMachine = !setup && (
    <ToolDetailSection title="Add a machine">
      <div className="space-y-1.5 text-sm text-muted-foreground" data-testid="fleet-add-machine">
        <p>On that computer, <a href="/download" className="font-semibold text-foreground underline-offset-2 hover:underline">open xMatrix</a> and
          sign in as you. It joins this list with the agents already installed on it.</p>
        <RemoteMachineHint copy={copy} />
      </div>
    </ToolDetailSection>
  );

  const chosenRow = view === "agents" ? rows.find((row) => row.id === selectedAgentId) : undefined;
  const chosenGroup = view === "agents" && !chosenRow
    ? groups.find((group) => agentHarnessSelectionId(group.harness) === selectedAgentId) : undefined;
  // An address that names an agent waits for the agent list before it falls back to the overview.
  const awaitingAgent = view === "agents" && Boolean(selectedAgentId) && !chosenRow && !chosenGroup && loading;
  const showsOverview = view === "status" || (view === "agents" && !chosenRow && !chosenGroup && !awaitingAgent);
  const attentionNote = attention.length ? ` · ${attention.length} ${attention.length === 1 ? "needs" : "need"} attention` : "";

  /** A machine the reader's list has no record of: named for what runs on it, with no page of its own to open. */
  const unlistedMachine = (section: (typeof elsewhere)[number]) => {
    const owners = ownedByReader(section) ? null
      : [...new Set(section.agents.map((row) => row.registration.ownerName))].join(", ");
    const up = section.agents.some((row) => row.registration.live?.machine.online);
    return (
      <section key={section.key} aria-label={section.name} data-testid="fleet-machine">
        <ul>
          <li className={cn(LIST_ROW_CLASS_NAME, "app-tool-list-group-title")}>
            <span className={cn(LIST_ROW_LEADING_CLASS_NAME, owners && LIST_ROW_LEADING_TWO_LINE_CLASS_NAME)}>
              <span className="app-tool-state-icon" data-state={up ? "running" : "offline"} aria-hidden="true">
                <MachineGlyph os={machineOs(section.platform)} /></span></span>
            <span className={LIST_ROW_COPY_CLASS_NAME}>
              <span className={LIST_ROW_TITLE_LINE_CLASS_NAME}><span className={LIST_ROW_TITLE_CLASS_NAME}>{section.name}</span></span>
              {owners && <span className={LIST_ROW_META_CLASS_NAME}>{owners}</span>}
            </span>
          </li>
          {section.agents.map((row) => agentRow(row, false))}
        </ul>
      </section>
    );
  };

  const list = (
    <ToolList title="Agents">
      {/* On a phone the overview leads the list: it is the first thing the tab shows. */}
      <div className="px-[var(--mobile-content-inset,1rem)] pt-3 pb-4 md:hidden">{overview}</div>
      {error && <p role="alert" className="px-5 pb-2 text-xs font-medium text-destructive md:px-6">{error}</p>}
      {model.identityUnavailable && <p role="status" className="px-5 pb-2 text-xs text-muted-foreground md:px-6">
        Update xMatrix to identify this computer and show its controls on the registered Machine.
      </p>}
      <ul>
        <ToolListRow testId="fleet-overview-row" desktopOnly selected={view === "status"}
          shownBeside={view !== "status" && showsOverview} onSelect={() => onChangeView("status")}
          leading={<Activity className="size-5 text-muted-foreground" />} title="Overview"
          subtitle={<>{status.workingCount} working{attentionNote && <span className={statusInkClass("attention")}>{attentionNote}</span>}</>} />
      </ul>
      {catalog.isError && (
        <ErrorNotice error={catalog.error} action="Couldn't load the agent list" onRetry={() => void catalog.refetch()}
          className={statusInkClass("alert", "px-5 py-2 text-sm md:px-6")} />
      )}
      {(machineSections.length > 0 || unlisted.length > 0 || loading) && <ListSectionHeading label={`Machines · ${status.online}/${status.machineCount} online`}
        mark={{ icon: HardDrive, tone: "primary" }} />}
      {machineSections.length === 0 && elsewhere.length === 0 && (loading
        ? <ListSkeleton label="Loading agents" rows={4} />
        : <p className="px-5 py-2 text-sm text-muted-foreground md:px-6">
          {ready ? "No machines yet." : "Choose a Space to see its machines and agents."}
        </p>)}
      {machineSections.map(({ machine, agents }) => {
        // This machine is a row like any other, only tagged; before the Hub lists it, the desktop says its state.
        const local = !machine || model.isThis(machine);
        const name = machine ? model.nameOf(machine) : thisMachine!.name;
        const host = machine ? model.hostOf(machine) : undefined;
        const facts = [host ? `WSL on ${model.nameOf(host)}` : null,
          machine ? machineStateLine(machine, status.workingOn(machine)) : thisMachine!.summary,
          machine && !model.autoAssigned(machine) ? "Named only" : null].filter(Boolean).join(" · ");
        const selected = onMachines && (local ? model.showingThis : machine!.id === model.chosen?.id);
        const beside = onMachines && !selectedMachineId && (local ? model.showThisBeside
          : !model.chosen && !model.showingThis && !model.showThisBeside && machine!.id === model.shown?.id);
        const machineId = machine ? machine.machineId : thisMachine?.machineId;
        const off = machineId ? newCandidates.filter((candidate) => candidate.key.machineId === machineId).length : 0;
        return (
          <section key={machine?.id ?? THIS_MACHINE_SELECTION} aria-label={name} data-testid="fleet-machine">
            <ul>
              <MachineListRow machine={machine} name={name}
                platform={local ? thisMachine!.platform : machinePlatform(machine!)}
                online={machine ? machine.status === "online" : thisMachine!.online} hosted={Boolean(host)}
                selected={selected} shownBeside={beside} onSelect={() => openMachine(machine)}
                now={now}
                subtitle={local ? <><ThisMachineTag label={model.thisLabel} />{facts ? <> · {facts}</> : null}</> : facts} />
              {agents.map((row) => agentRow(row, true))}
              {off > 0 && <li>
                {/* Installed here and not in this Space: one quiet line, turned on from the machine's page. */}
                <button type="button" data-testid="fleet-machine-off" onClick={() => openMachine(machine)}
                  className="w-full py-1.5 pl-[calc(var(--app-list-row-start)+1.875rem)] pr-[var(--app-list-row-end)] text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                  {off} more installed · off in this Space
                </button>
              </li>}
            </ul>
          </section>
        );
      })}
      {unlisted.map(unlistedMachine)}
      {teammates.length > 0 && <ListSectionHeading label="Teammates' machines" mark={{ icon: Users, tone: "plain" }} />}
      {teammates.map(unlistedMachine)}
      <div className="px-[var(--mobile-content-inset,1rem)] pt-8 md:hidden">{addMachine}</div>
    </ToolList>
  );

  const detail = awaitingAgent ? <ToolPaperScroll><ContentSkeleton label="Loading agent" lines={4} /></ToolPaperScroll>
    : showsOverview ? (setup
      ? <div className="app-below-band min-h-0 flex-1 overflow-y-auto">{overview}</div>
      : <ToolPaperScroll>{overview}<div className="mt-8">{addMachine}</div></ToolPaperScroll>)
      : view === "agents" ? (
        <AgentPaper spaceId={spaceId} token={token} currentUserId={currentUserId} chosen={chosenRow} group={chosenGroup}
          now={now} working={status.workingInstanceIds} fleet={fleet} conversationTitle={conversationTitle}
          machineOf={machineOf} onRefetch={() => catalog.refetch()} onOpenMachine={openMachine}
          onOpenConversation={onOpenConversation} />
      ) : (
        <MachinePaper model={model} edits={edits} select={selectMachine} loading={false} token={token}
          spaceId={spaceId ?? undefined} thisMachine={thisMachine}
          agentOn={(machine, harness) => {
            const row = rowOn(machine, harness);
            return row && { state: row.activity.state, line: rowLine(row), usage: row.usage };
          }}
          onOpenAgent={(machine, harness) => {
            const row = rowOn(machine, harness);
            if (row) onChangeView("agents", row.id);
          }} />
      );
  const open = view === "agents" ? Boolean(chosenRow || chosenGroup || awaitingAgent) : onMachines ? Boolean(selectedMachineId) : false;

  return <ToolSplit label="Agents" open={open} list={list} detail={detail} />;
}
