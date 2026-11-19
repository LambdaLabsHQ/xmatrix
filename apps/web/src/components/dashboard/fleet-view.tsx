"use client";

import { Activity } from "lucide-react";
import type { AgentRegistrationSummary, ChannelSnapshot, ObservabilityEvent } from "@xmatrix/protocol";

import { ErrorNotice } from "@/components/ui/error-notice";
import { statusInkClass } from "@/components/ui/status-tone";

import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { agentHarnessSelectionId, agentListGroups, type AgentListGroup } from "./agent-list-groups";
import { AGENT_USAGE_REFRESH_MS } from "./agent-quota-usage";
import { useNow } from "./agent-work-intent";
import { channelTitle } from "./channel-links";
import { ListSkeleton } from "./content-skeleton";
import { Face } from "./face";
import { InstalledHarnessSwitchList } from "./installed-harness-switch-list";
import { MachineGlyph } from "./machine-glyph";
import { MachineListRow, machinePlatform, machineStateLine, machineUnresponsive } from "./machine-list-row";
import { signedOutRegistrations } from "./harness-sign-in";
import { MachineLoadGlanceBars } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import { AgentPaper } from "./my-agents-view";
import { FleetOverview, useFleetStatus, type FleetOverviewLine } from "./status-view";
import { ToolList, ToolListGroup, ToolListRow, ToolPaperScroll, ToolSplit } from "./tool-split";
import { useViewSelection } from "./url-query-state";
import { useInstalledHarnesses } from "./use-installed-harnesses";
import {
  MachinePaper, THIS_MACHINE_SELECTION, ThisMachineTag, machineListModel, useMachineEdits, type ThisMachine,
} from "./workspace-fleet-views";
import type { MachineSummary } from "./workspace-shell-helpers";

/** The three addresses of the one destination: the overview, an agent, a machine. */
export type FleetAddress = "status" | "agents" | "machines" | "local";

type AgentRow = AgentListGroup["rows"][number];

/** An agent under its machine is named by its program; a name the Space gave it is the name people call it by. */
function agentRowName(row: AgentRow): string {
  return row.machineInLine ? row.title : row.harness;
}

/**
 * Agents: every machine of the Space with the agents on it, in one list. The
 * paper beside it is whatever is chosen there: the Space at work (the
 * overview), a machine (its daemon, and installing, signing in and turning on
 * an agent on it), or an agent on its machine (what it runs, its usage and
 * settings). Each has an address of its own, so a link to one still opens it.
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
  /** The desktop app reports this machine's harnesses itself; a browser cannot. */
  addsOnThisMachine: boolean;
  thisMachine?: ThisMachine | null;
  onChangeView: (view: FleetAddress, selection?: string) => void;
  onOpenConversation: (channelId: string) => void;
}) {
  const ready = Boolean(spaceId && token);
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", ready, { live: true });
  const fleet = useInstalledHarnesses(spaceId, token, currentUserId);
  // Ticks with the catalog refresh, so ages, load samples and reset countdowns keep moving.
  const now = useNow(AGENT_USAGE_REFRESH_MS);
  const status = useFleetStatus({ catalog: catalog.data, machines, channels, events, now });
  const [selectedAgentId, selectAgent] = useViewSelection("agents");
  const [selectedMachineId, selectMachine] = useViewSelection("machines");
  const edits = useMachineEdits();
  const onMachines = view === "machines" || view === "local";
  const model = machineListModel({ machines, thisMachine, edits,
    selectedMachineId: onMachines ? selectedMachineId : null,
    defaultMachineId: view === "local" ? THIS_MACHINE_SELECTION : undefined });

  const openAgent = (id: string) => view === "agents" ? selectAgent(id) : onChangeView("agents", id);
  const openMachine = (id: string) => onMachines ? selectMachine(id) : onChangeView("machines", id);

  const conversationTitle = (channelId: string) => {
    const channel = channels.find((candidate) => candidate.id === channelId);
    return channel ? channelTitle(channel) : undefined;
  };
  const groups = agentListGroups(catalog.data, { conversationTitle, now });
  const rows = groups.flatMap((group) => group.rows)
    .sort((left, right) => left.activity.rank - right.activity.rank || agentRowName(left).localeCompare(agentRowName(right)));
  const placed = new Set<string>();
  const agentsOn = (machine: MachineSummary | null): AgentRow[] => {
    const machineId = machine ? machine.machineId : thisMachine?.machineId;
    const found = rows.filter((row) => !placed.has(row.id) && (machineId ? row.registration.key.machineId === machineId
      : Boolean(machine) && row.registration.machineName === machine!.name));
    for (const row of found) placed.add(row.id);
    return found;
  };
  const machineSections = model.ordered.map((machine) => ({ machine, agents: agentsOn(machine) }));
  // An agent on a Machine this reader's list does not carry (another member's) is listed under that Machine's name.
  const elsewhere = rows.filter((row) => !placed.has(row.id)).reduce<Array<{ key: string; name: string; platform?: string; agents: AgentRow[] }>>(
    (sections, row) => {
      const key = row.registration.key.machineId;
      const section = sections.find((candidate) => candidate.key === key);
      if (section) section.agents.push(row);
      else sections.push({ key, name: row.registration.machineName, platform: row.registration.live?.machine.platform, agents: [row] });
      return sections;
    }, []);
  const newCandidates = fleet.candidates.filter((candidate) => !candidate.registration);

  const agentRow = (row: AgentRow, child: boolean) => (
    <ToolListRow key={row.id} testId="agent-row" state={row.activity.state} child={child}
      selected={view === "agents" && row.id === selectedAgentId}
      onSelect={() => openAgent(row.id)}
      leading={<span className="app-tool-state-icon" data-state={row.activity.state} aria-hidden="true">
        <Face of={{ kind: "agent", name: row.harness, harness: row.harness }} size="xs" showKindBadge={false} /></span>}
      trailing={<MachineLoadGlanceBars glance={row.usage}
        testId="agent-usage-glance" label={row.usage.map((reading) => reading.detail).join(", ")} />}
      title={agentRowName(row)}
      end={row.registration.key.ownerUserId === currentUserId ? undefined : row.registration.ownerName}
      subtitle={row.machineInLine ? `${row.harness} · ${row.activity.line}` : row.activity.line} />
  );

  const signedOut = new Set(signedOutRegistrations(rows.map((row) => row.registration), currentUserId, fleet.daemons.data));
  const placeOf = (row: AgentRow) => `${agentRowName(row)} · ${row.registration.machineName}`;
  const attention: FleetOverviewLine[] = [
    ...rows.flatMap((row) => {
      const mine = row.registration.key.ownerUserId === currentUserId;
      const line = signedOut.has(row.registration) ? "Not signed in"
        : row.activity.state === "attention" ? row.activity.line
          : mine && row.registration.state === "enabled" && row.registration.access && !row.registration.access.confirmed
            ? "Access on its machine not confirmed" : null;
      return line ? [{ key: row.id, harness: row.harness, title: placeOf(row), line, onOpen: () => onChangeView("agents", row.id) }] : [];
    }),
  ];
  const unresponsive = model.listed.filter(machineUnresponsive);
  // One line for an agent in a conversation, however many of it work there.
  const workingNow: FleetOverviewLine[] = rows.flatMap((row) => {
    const working = (row.registration.live?.running ?? []).filter((instance) => status.workingInstanceIds.has(instance.instanceId));
    return [...new Set(working.map((instance) => instance.channelId))].map((channelId) => {
      const title = conversationTitle(channelId);
      const count = working.filter((instance) => instance.channelId === channelId).length;
      return { key: `${row.id}:${channelId}`, harness: row.harness, title: placeOf(row),
        line: `${count > 1 ? `${count} in ` : ""}${title ? `#${title}` : "a conversation"}`,
        onOpen: () => title ? onOpenConversation(channelId) : onChangeView("agents", row.id) };
    });
  });

  const overview = (
    <FleetOverview status={status} now={now} attention={attention} workingNow={workingNow} unresponsive={unresponsive.map((machine) => ({
      id: machine.id, name: model.nameOf(machine) }))} loading={ready && !catalog.data && !catalog.isError}
      error={catalog.isError ? catalog.error : null} onRetry={() => void catalog.refetch()}
      onOpenHarness={(harness) => onChangeView("agents", agentHarnessSelectionId(harness))}
      onOpenMachine={(id) => onChangeView("machines", id)} onSetUpAgents={() => onChangeView("agents")} />
  );

  const list = (
    <ToolList title="Agents">
      {/* On a phone the overview leads the list: it is the first thing the tab shows. */}
      <div className="px-[var(--mobile-content-inset,1rem)] pt-3 pb-6 md:hidden">{overview}</div>
      {error && <p role="alert" className="px-5 pb-2 text-xs font-medium text-destructive md:px-6">{error}</p>}
      {model.identityUnavailable && <p role="status" className="px-5 pb-2 text-xs text-muted-foreground md:px-6">
        Update xMatrix to identify this computer and show its controls on the registered Machine.
      </p>}
      <ul>
        <ToolListRow testId="fleet-overview-row" desktopOnly selected={view === "status"} onSelect={() => onChangeView("status")}
          leading={<Activity className="size-5 text-muted-foreground" />} title="Overview"
          subtitle={`${status.workingCount} working · ${status.online}/${status.machineRows.length} machines online`} />
      </ul>
      {catalog.isError && (
        <ErrorNotice error={catalog.error} action="Couldn't load the agent list" onRetry={() => void catalog.refetch()}
          className={statusInkClass("alert", "px-5 py-2 text-sm md:px-6")} />
      )}
      {machineSections.length === 0 && elsewhere.length === 0 && (ready && !catalog.data && !catalog.isError
        ? <ListSkeleton label="Loading agents" rows={4} />
        : <p className="px-5 py-2 text-sm text-muted-foreground md:px-6">
          {!ready ? "Choose a Space to see its machines and agents."
            : newCandidates.length ? "Turn on a harness below to summon it here." : "No machines registered."}
        </p>)}
      {machineSections.map(({ machine, agents }) => {
        // This machine is a row like any other, only tagged; before the Hub lists it, the desktop says its state.
        const local = !machine || model.isThis(machine);
        const name = machine ? model.nameOf(machine) : thisMachine!.name;
        const host = machine ? model.hostOf(machine) : undefined;
        const facts = [host ? `WSL on ${model.nameOf(host)}` : null,
          machine ? machineStateLine(machine) : thisMachine!.summary,
          machine && !model.autoAssigned(machine) ? "Named only" : null].filter(Boolean).join(" · ");
        const selected = onMachines && (local ? model.showingThis : machine!.id === model.chosen?.id);
        const beside = onMachines && !selectedMachineId && (local ? model.showThisBeside
          : !model.chosen && !model.showingThis && !model.showThisBeside && machine!.id === model.shown?.id);
        return (
          <section key={machine?.id ?? THIS_MACHINE_SELECTION} aria-label={name} data-testid="fleet-machine" className="mt-1">
            <ul>
              <MachineListRow machine={machine} name={name}
                platform={local ? thisMachine!.platform : machinePlatform(machine!)}
                online={machine ? machine.status === "online" : thisMachine!.online} hosted={Boolean(host)}
                selected={selected} shownBeside={beside}
                onSelect={() => openMachine(local ? THIS_MACHINE_SELECTION : machine!.id)}
                now={now}
                subtitle={local ? <><ThisMachineTag label={model.thisLabel} />{facts ? <> · {facts}</> : null}</> : facts} />
              {agents.map((row) => agentRow(row, true))}
            </ul>
          </section>
        );
      })}
      {elsewhere.map((section) => (
        <ToolListGroup key={section.key} title={section.name} count={section.agents.length} identity
          icon={<span className="app-tool-state-icon flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
            <MachineGlyph os={machineOs(section.platform)} /></span>}>
          {section.agents.map((row) => agentRow(row, false))}
        </ToolListGroup>
      ))}
      {ready && (newCandidates.length > 0 || fleet.daemons.isError) && <ToolListGroup title="Installed on your machines" count={newCandidates.length}>
        <div className="px-4 md:px-5"><InstalledHarnessSwitchList fleet={fleet} onlyNew /></div>
      </ToolListGroup>}
    </ToolList>
  );

  const registrationOn = (machine: MachineSummary, harness: string): AgentRegistrationSummary | undefined =>
    rows.find((row) => row.harness === harness && row.registration.key.machineId === machine.machineId
      && row.registration.key.ownerUserId === currentUserId)?.registration
    ?? rows.find((row) => row.harness === harness && row.registration.key.machineId === machine.machineId)?.registration;

  const detail = view === "status" ? <ToolPaperScroll>{overview}</ToolPaperScroll>
    : view === "agents" ? (
      <AgentPaper spaceId={spaceId} token={token} currentUserId={currentUserId} channels={channels} machines={machines}
        addsOnThisMachine={addsOnThisMachine} onOpenMachines={() => onChangeView("machines")}
        onOpenMachine={(machine) => onChangeView("machines", model.isThis(machine) ? THIS_MACHINE_SELECTION : machine.id)}
        onOpenConversation={onOpenConversation} />
    ) : (
      <MachinePaper model={model} edits={edits} select={selectMachine} loading={false} token={token}
        spaceId={spaceId ?? undefined} thisMachine={thisMachine}
        onOpenAgent={(machine, harness) => {
          const registration = registrationOn(machine, harness);
          if (registration) onChangeView("agents", rows.find((row) => row.registration === registration)!.id);
        }} />
    );
  const open = view === "agents" ? Boolean(selectedAgentId) : onMachines ? Boolean(selectedMachineId) : false;

  return <ToolSplit label="Agents" open={open} list={list} detail={detail} />;
}
