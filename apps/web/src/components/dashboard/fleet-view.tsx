"use client";

import { HardDrive, Plus, Users } from "lucide-react";
import { useState } from "react";
import { AGENT_PRESETS, parseHarnessInventory, type AgentRegistrationSummary, type ChannelSnapshot, type ObservabilityEvent } from "@xmatrix/protocol";

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
import { FleetMatrix, type FleetMatrixCell, type FleetMatrixRow } from "./fleet-matrix";
import { ListSectionHeading } from "./list-section-heading";
import { MachineGlyph } from "./machine-glyph";
import { MachineListRow, machinePlatform, machineStateLine, machineUnresponsive } from "./machine-list-row";
import { MachineLoadGlance, MachineLoadGlanceBars } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import { AgentPaper } from "./my-agents-view";
import { SetupCardShell } from "./space-setup-card-chrome";
import { FleetOverview, FleetRuntimeLines, runtimeLine, useFleetStatus, type FleetOverviewLine, type FleetRuntime } from "./status-view";
import {
  LIST_ROW_CLASS_NAME, LIST_ROW_COPY_CLASS_NAME, LIST_ROW_LEADING_CLASS_NAME, LIST_ROW_LEADING_TWO_LINE_CLASS_NAME,
  LIST_ROW_META_CLASS_NAME, LIST_ROW_TITLE_CLASS_NAME, LIST_ROW_TITLE_LINE_CLASS_NAME,
} from "./row-frames";
import { ToolDetailSection, ToolList, ToolListRow, ToolPaperScroll, ToolSheet, ToolSplit } from "./tool-split";
import { useViewSelection } from "./url-query-state";
import { useInstalledHarnesses } from "./use-installed-harnesses";
import {
  MachinePaper, THIS_MACHINE_SELECTION, ThisMachineTag, machineListModel, useMachineEdits, type ThisMachine,
} from "./workspace-fleet-views";
import { useIsMobileViewport, type MachineSummary } from "./workspace-shell-helpers";

/** The addresses of the one destination: the overview, an agent, a machine, this machine. */
export type FleetAddress = "status" | "agents" | "machines" | "local";

type AgentRow = AgentListGroup["rows"][number];

/** An agent is named by what people call it: the name the Space gave it, else its program's. */
function agentRowName(row: AgentRow): string {
  return row.machineInLine ? row.title : row.harness;
}

/** What a cell has room to say of an agent that waits on its owner. */
function cellAttention(brief: string): string {
  if (brief === "Not signed in") return "Sign in";
  if (brief.startsWith("Too old")) return "Update";
  if (brief === "Not set up on its machine") return "Set up";
  if (brief === "Out of quota · window unavailable") return "Out of quota";
  if (brief === "Out of balance") return "No balance";
  return brief.replace(/ limit reached$/u, " limit");
}

/**
 * Agents: the Space's machines and the agents on them. On a desktop that is
 * one matrix, a machine to a row and an agent to a column, which lists both
 * at once; a heading or a cell opens in its place, with a way back. On a
 * phone, too narrow for it, the same machines are a list with their agents
 * under them. What opens is a machine (the agents installed on it, where one
 * is added, signed in and turned on, then its load and settings), an agent
 * on its machine (what it works on, its usage and settings), or an agent
 * across its machines. Each has an address of its own, so a link to one
 * still opens it.
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
  const phone = useIsMobileViewport();
  // The agent a machine was opened for from its cell, so its line there is the one in view.
  const [focus, setFocus] = useState<{ machine: string; harness: string } | null>(null);
  // Agents installed nowhere yet are further columns only when asked for.
  const [allAgents, setAllAgents] = useState(false);
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
      // Only what cannot take work until someone acts: exactly the cells the matrix draws in that ink.
      if (row.activity.state !== "attention") return [];
      const { registration } = row;
      const machine = machineOf(registration);
      const outdated = tooOld.has(candidateId(registration));
      const line = row.activity.brief;
      // A program is updated on its machine's page; everything else is on the agent's own.
      return [{ key: row.id, harness: row.harness, title: placeOf(row), line,
        onOpen: () => outdated && machine ? onChangeView("machines", machine.id) : onChangeView("agents", row.id) }];
    }),
  ];

  // An empty Space has nothing to overview: it shows where agents come from.
  const empty = Boolean(catalog.data) && rows.length === 0;
  // The machine to open for it: one with something installed, else this machine, else any of the reader's own.
  const firstOwn = model.listed.find((machine) => newCandidates.some((candidate) => candidate.key.machineId === machine.machineId))
    ?? (thisMachine ? null : model.listed.find((machine) => machine.daemon?.userId === currentUserId));
  // With no machine either there is nothing to list: the Space reads how its first machine is connected.
  const setup = empty && newCandidates.length === 0 && !addsOnThisMachine && model.ordered.length === 0 && elsewhere.length === 0;
  const bringIn = (
    <SetupCardShell>
      <BringAgentsIn spaceId={spaceId} token={token} userId={currentUserId} surface="agents" />
    </SetupCardShell>
  );
  // No agent in the Space yet, though one is installed: where it is turned on.
  const turnOn = empty ? (
    <div className="space-y-3 text-sm text-muted-foreground" data-testid="fleet-empty">
      <p className="font-bold text-foreground">{newCandidates.length ? copy.enableInstalledTitle : copy.connectAgentsTitle}</p>
      <p>{copy.enableOrInstall}</p>
      {firstOwn !== undefined && <Button size="sm" variant="outline" onClick={() => openMachine(firstOwn)}>
        <Plus /> {firstOwn ? `Open ${model.nameOf(firstOwn)}` : `Open ${model.thisLabel}`}</Button>}
    </div>
  ) : undefined;
  const addMachine = !setup && (
    <ToolDetailSection title="Add a machine">
      <div className="space-y-1.5 text-sm text-muted-foreground" data-testid="fleet-add-machine">
        <p>On that computer, <a href="/download" className="font-semibold text-foreground underline-offset-2 hover:underline">open xMatrix</a> and
          sign in as you. It joins this list with the agents already installed on it.</p>
        <RemoteMachineHint copy={copy} />
      </div>
    </ToolDetailSection>
  );
  const catalogError = catalog.isError && (
    <ErrorNotice error={catalog.error} action="Couldn't load the agent list" onRetry={() => void catalog.refetch()}
      className={statusInkClass("alert", "text-sm")} />
  );

  const chosenRow = view === "agents" ? rows.find((row) => row.id === selectedAgentId) : undefined;
  const chosenGroup = view === "agents" && !chosenRow
    ? groups.find((group) => agentHarnessSelectionId(group.harness) === selectedAgentId) : undefined;
  // An address that names an agent waits for the agent list before it falls back to the overview.
  const awaitingAgent = view === "agents" && Boolean(selectedAgentId) && !chosenRow && !chosenGroup && loading;
  const showsOverview = view === "status" || (view === "agents" && !chosenRow && !chosenGroup && !awaitingAgent)
    // With no list to choose from, a desktop's bare machines address is the matrix, not the first machine.
    || (!phone && view === "machines" && !selectedMachineId);
  // A desktop's page goes back to the matrix; a phone's closes over its list.
  const back = phone ? undefined : () => onChangeView("status");

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
      <div className="px-[var(--mobile-content-inset,1rem)] pt-3 pb-4">{setup ? bringIn : (
        <FleetOverview status={status} attention={attention}>
          <FleetRuntimeLines runtimes={runtimes} loading={loading} error={catalog.isError ? catalog.error : null}
            onRetry={() => void catalog.refetch()} empty={turnOn}
            onOpenHarness={(harness) => onChangeView("agents", agentHarnessSelectionId(harness))} />
        </FleetOverview>
      )}</div>
      {error && <p role="alert" className="px-5 pb-2 text-xs font-medium text-destructive md:px-6">{error}</p>}
      {model.identityUnavailable && <p role="status" className="px-5 pb-2 text-xs text-muted-foreground md:px-6">
        Update xMatrix to identify this computer and show its controls on the registered Machine.
      </p>}
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
      <div className="px-[var(--mobile-content-inset,1rem)] pt-8">{addMachine}</div>
    </ToolList>
  );

  // ---- The matrix: a machine to a row, an agent to a column. ----------------------------------------
  /** What the reader's own machine reports of each program; another member's machine reports nothing to this reader. */
  const inventoryOf = (machine: MachineSummary) => machine.daemon?.userId === currentUserId
    ? parseHarnessInventory(machine.daemon.metadata.harnesses)?.items : undefined;
  const agentCell = (row: AgentRow): FleetMatrixCell => ({
    kind: "agent", id: row.id, state: row.activity.state, working: row.activity.working, usage: row.usage,
    detail: rowLine(row), name: row.machineInLine ? row.title : undefined,
    // Its row already says its machine is offline: the cell says only that the agent is on, beside those that are off.
    label: row.activity.state === "running" ? (row.activity.working > 0 ? `${row.activity.working} working` : "Ready")
      : row.activity.state === "offline" ? "On" : row.activity.state === "paused" ? "Off" : cellAttention(row.activity.brief),
    onOpen: () => onChangeView("agents", row.id),
  });
  const present = new Set(groups.map((group) => group.harness));
  for (const machine of model.listed) {
    for (const item of inventoryOf(machine) ?? []) if (item.installed && item.id !== "custom") present.add(item.id);
  }
  const runtimeOf = (harness: string) => runtimes.find((runtime) => runtime.harness === harness);
  const offered = AGENT_PRESETS.map((preset) => preset.id).filter((id) => id !== "custom" && !present.has(id));
  // A column keeps its place while work comes and goes: the agents on the most machines first, then by name.
  const harnesses = [
    ...[...present].sort((left, right) => (runtimeOf(right)?.total ?? 0) - (runtimeOf(left)?.total ?? 0) || left.localeCompare(right)),
    ...(allAgents ? offered : []),
  ];
  const columns = harnesses.map((harness) => {
    const runtime = runtimeOf(harness);
    return {
      harness,
      summary: runtime ? `${runtime.working > 0 ? `${runtime.working} working · ` : ""}${runtimeLine(runtime)}`
        : present.has(harness) ? "Installed, and off in this Space" : "Not installed on any of your machines",
      // What the Space set on an agent exists once the Space has it.
      onOpen: runtime ? () => onChangeView("agents", agentHarnessSelectionId(harness)) : undefined,
    };
  });
  const cellsOf = (pick: (harness: string) => FleetMatrixCell) => Object.fromEntries(harnesses.map((harness) => [harness, pick(harness)]));
  // No `rounded` on what is not a button: a rounded span is drawn as a chip everywhere in the app.
  const machineHeading = "flex w-full min-w-0 items-center gap-2.5 px-1.5 py-1.5 text-left";
  const matrixRows: FleetMatrixRow[] = [
    ...model.ordered.map((machine): FleetMatrixRow => {
      // This machine is a row like any other, only tagged; before the Hub lists it, the desktop says its state.
      const local = !machine || model.isThis(machine);
      const name = machine ? model.nameOf(machine) : thisMachine!.name;
      const host = machine ? model.hostOf(machine) : undefined;
      const online = machine ? machine.status === "online" : thisMachine!.online;
      const stalled = Boolean(machine && machineUnresponsive(machine));
      const facts = [host ? `WSL on ${model.nameOf(host)}` : null,
        machine ? machineStateLine(machine, status.workingOn(machine)) : thisMachine!.summary,
        machine && !model.autoAssigned(machine) ? "Named only" : null].filter(Boolean).join(" · ");
      const items = machine ? inventoryOf(machine) : undefined;
      const machineId = machine ? machine.machineId : thisMachine?.machineId;
      return {
        key: machine?.id ?? THIS_MACHINE_SELECTION, name, dimmed: !online,
        heading: (
          <button type="button" data-testid="machine-row" onClick={() => { setFocus(null); openMachine(machine); }}
            className={cn(machineHeading, "rounded hover:bg-foreground/5", host && "pl-5")}>
            <span className="app-tool-state-icon shrink-0" data-state={stalled ? "attention" : online ? "running" : "offline"}
              aria-label={`${name}: ${stalled ? "not responding" : online ? "online" : "offline"}`} role="img">
              <MachineGlyph os={machineOs(local ? thisMachine!.platform : machinePlatform(machine!))} /></span>
            <span className="min-w-0 flex-1">
              <span className="app-list-row-title block truncate font-semibold">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {local && <ThisMachineTag label={model.thisLabel} />}{local && facts ? " · " : null}{facts}</span>
              {machine && <span className="mt-1 block empty:hidden"><MachineLoadGlance machine={machine} now={now} /></span>}
            </span>
          </button>
        ),
        cells: cellsOf((harness) => {
          const row = rows.find((candidate) => candidate.harness === harness && Boolean(machineId)
            && candidate.registration.key.machineId === machineId);
          if (row) return agentCell(row);
          const item = items?.find((entry) => entry.id === harness);
          if (!machine || !item) return { kind: "unknown" };
          const open = () => { setFocus({ machine: machine.id, harness }); openMachine(machine); };
          return item.installed ? { kind: "off", onOpen: open }
            : item.probeStatus === "unsupported" ? { kind: "unsupported" } : { kind: "absent", onOpen: open };
        }),
      };
    }),
    // A machine the reader's list has no record of: named for what runs on it, with no page of its own to open.
    ...[...unlisted, ...teammates].map((section): FleetMatrixRow => {
      const mine = ownedByReader(section);
      const up = section.agents.some((row) => row.registration.live?.machine.online);
      const owners = [...new Set(section.agents.map((row) => row.registration.ownerName))].join(", ");
      return {
        key: section.key, name: section.name, dimmed: !up, group: mine ? undefined : "Teammates' machines",
        heading: (
          <span className={machineHeading}>
            <span className="app-tool-state-icon shrink-0" data-state={up ? "running" : "offline"} aria-hidden="true">
              <MachineGlyph os={machineOs(section.platform)} /></span>
            <span className="min-w-0 flex-1">
              <span className="app-list-row-title block truncate font-semibold">{section.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[mine ? null : owners, up ? null : "Offline"].filter(Boolean).join(" · ")}</span>
            </span>
          </span>
        ),
        cells: cellsOf((harness) => {
          const row = section.agents.find((candidate) => candidate.harness === harness);
          return row ? agentCell(row) : { kind: "unknown" };
        }),
      };
    }),
  ];

  const page = awaitingAgent ? <ToolPaperScroll><ContentSkeleton label="Loading agent" lines={4} /></ToolPaperScroll>
    : view === "agents" ? (
      <AgentPaper spaceId={spaceId} token={token} currentUserId={currentUserId} chosen={chosenRow} group={chosenGroup}
        now={now} working={status.workingInstanceIds} fleet={fleet} conversationTitle={conversationTitle}
        machineOf={machineOf} backAlways={!phone} onBack={back ?? (() => selectAgent(null))}
        onRefetch={() => catalog.refetch()} onOpenMachine={(machine) => { setFocus(null); openMachine(machine); }}
        onOpenConversation={onOpenConversation} />
    ) : (
      <MachinePaper model={model} edits={edits} select={selectMachine} loading={false} token={token}
        spaceId={spaceId ?? undefined} thisMachine={thisMachine} backAlways={!phone} onBack={back}
        focusAgent={focus && (focus.machine === (model.chosen?.id ?? model.shown?.id)) ? focus.harness : undefined}
        agentOn={(machine, harness) => {
          const row = rowOn(machine, harness);
          return row && { state: row.activity.state, line: rowLine(row), usage: row.usage };
        }}
        onOpenAgent={(machine, harness) => {
          const row = rowOn(machine, harness);
          if (row) onChangeView("agents", row.id);
        }} />
    );

  if (phone) {
    const open = view === "agents" ? Boolean(chosenRow || chosenGroup || awaitingAgent) : onMachines ? Boolean(selectedMachineId) : false;
    return <ToolSplit label="Agents" open={open} list={list} detail={showsOverview ? null : page} />;
  }
  if (!showsOverview) return <ToolSheet label="Agents">{page}</ToolSheet>;
  return (
    <ToolSheet label="Agents">
      <ToolPaperScroll wide>
        <h1 className="mb-6 text-xs font-black uppercase tracking-wide text-muted-foreground">Agents</h1>
        {setup ? bringIn : <>
          {error && <p role="alert" className="mb-4 text-xs font-medium text-destructive">{error}</p>}
          {model.identityUnavailable && <p role="status" className="mb-4 text-xs text-muted-foreground">
            Update xMatrix to identify this computer and show its controls on the registered Machine.
          </p>}
          {/* The matrix shows each thing that waits on a person in its own cell, so no list repeats them here. */}
          <FleetOverview status={status} attention={[]} note={attention.length > 0 && (
            <span className={statusInkClass("attention")} data-testid="fleet-attention-count">
              {" · "}{attention.length} {attention.length === 1 ? "needs" : "need"} attention</span>
          )}>
            {catalogError}
            {turnOn}
            <section aria-label="Machines and agents" className="space-y-3">
              {matrixRows.length === 0 ? (loading
                ? <ContentSkeleton label="Loading machines and agents" lines={4} />
                : <p className="text-sm text-muted-foreground">{ready ? "No machines yet." : "Choose a Space to see its machines and agents."}</p>)
                : <FleetMatrix columns={columns} rows={matrixRows}
                  more={{ count: offered.length, open: allAgents, onToggle: () => setAllAgents(!allAgents) }} />}
              {matrixRows.length > 0 && columns.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  A cell is an agent on a machine. <span className="font-semibold">Off</span>: installed, not turned on in this Space.{" "}
                  <span className="font-semibold">+</span>: not installed; it opens the machine, where it is installed.{" "}
                  <span className="font-semibold">—</span>: cannot run on that machine.
                </p>
              )}
            </section>
            {addMachine}
          </FleetOverview>
        </>}
      </ToolPaperScroll>
    </ToolSheet>
  );
}
