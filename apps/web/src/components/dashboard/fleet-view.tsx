"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import {
  AGENT_PRESETS, machineResourceObservation, parseHarnessInventory,
  type AgentRegistrationSummary, type ChannelSnapshot, type ObservabilityEvent,
} from "@xmatrix/protocol";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ui/error-notice";
import { statusInkClass } from "@/components/ui/status-tone";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { cn } from "@/lib/utils";

import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { agentHarnessSelectionId, agentListGroups, type AgentListGroup } from "./agent-list-groups";
import { AGENT_USAGE_REFRESH_MS } from "./agent-quota-usage";
import { useNow } from "./agent-work-intent";
import { BringAgentsIn } from "./bring-agents-in";
import { channelTitle } from "./channel-links";
import { ContentSkeleton } from "./content-skeleton";
import { signedOutRegistrations } from "./harness-sign-in";
import { FleetCellEditor } from "./fleet-cell-editor";
import { FleetMatrix, type FleetMatrixCell, type FleetMatrixCellKey, type FleetMatrixEditor, type FleetMatrixRow } from "./fleet-matrix";
import { MobileAvatarMatrix, mobileAttentionPhrase, type MobileMatrixRow } from "./fleet-mobile";
import { MachineGlyph } from "./machine-glyph";
import { machinePlatform, machineStateLine, machineUnresponsive } from "./machine-list-row";
import { machineGlanceReadings, machineLoadReadings, meterTone } from "./machine-load";
import { MachineLoadGlance } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import { AgentPaper } from "./my-agents-view";
import { SetupCardShell } from "./space-setup-card-chrome";
import { FleetOverview, runtimeLine, useFleetStatus, type FleetRuntime } from "./status-view";
import { ToolList, ToolPaperScroll, ToolSheet, ToolSplit } from "./tool-split";
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
  // The cell being edited, as a spreadsheet has one cell chosen.
  const [cell, setCell] = useState<FleetMatrixCellKey | null>(null);
  // What is being done on a machine to the agent of a cell, by cell: it is said in the cell and outlives its editor.
  const [doing, setDoing] = useState<Record<string, string>>({});
  // Columns added for agents no machine has yet, and the row that adds a machine.
  const [addedColumns, setAddedColumns] = useState<string[]>([]);
  const [addingMachine, setAddingMachine] = useState(false);
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
  for (const machine of model.ordered) agentsOn(machine);
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

  // ---- The matrix & mobile cells: a machine to a row, an agent to a column / grid tile. ----
  /** What the reader's own machine reports of each program; another member's machine reports nothing to this reader. */
  const inventoryOf = (machine: MachineSummary) => machine.daemon?.userId === currentUserId
    ? parseHarnessInventory(machine.daemon.metadata.harnesses)?.items : undefined;
  const cellKey = (row: string, harness: string) => `${row}|${harness}`;
  const agentCell = (row: AgentRow): FleetMatrixCell => ({
    kind: "agent", state: row.activity.state, working: row.activity.working, usage: row.usage,
    detail: rowLine(row), name: row.machineInLine ? row.title : undefined,
    // Its row already says its machine is offline: the cell says only that the agent is on, beside those that are off.
    label: row.activity.state === "running" ? (row.activity.working > 0 ? `${row.activity.working} working` : "Ready")
      : row.activity.state === "offline" ? "On" : row.activity.state === "paused" ? "Off" : cellAttention(row.activity.brief),
  });
  const present = new Set(groups.map((group) => group.harness));
  for (const machine of model.listed) {
    for (const item of inventoryOf(machine) ?? []) if (item.installed && item.id !== "custom") present.add(item.id);
  }
  const runtimeOf = (harness: string) => runtimes.find((runtime) => runtime.harness === harness);
  const added = addedColumns.filter((harness) => !present.has(harness));
  const offered = AGENT_PRESETS.filter((preset) => preset.id !== "custom" && !present.has(preset.id) && !added.includes(preset.id));
  // A column keeps its place while work comes and goes: the agents on the most machines first, then by name;
  // one added by hand stays at the end until a machine has it.
  const harnesses = [
    ...[...present].sort((left, right) => (runtimeOf(right)?.total ?? 0) - (runtimeOf(left)?.total ?? 0) || left.localeCompare(right)),
    ...added,
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
  const cellsOf = (rowKey: string, pick: (harness: string) => FleetMatrixCell) => Object.fromEntries(harnesses.map((harness) => {
    const busy = doing[cellKey(rowKey, harness)];
    const found = pick(harness);
    return [harness, busy && found.kind !== "unknown" && found.kind !== "unsupported" ? { ...found, busy } : found];
  }));
  // No `rounded` on what is not a button: a rounded span is drawn as a chip everywhere in the app.
  const machineHeading = "flex w-full min-w-0 items-center gap-2.5 px-1.5 py-1.5 text-left";
  /** What a row is for its cells' editors: the machine it is, and the agents on it. */
  type RowSubject = { name: string; machine?: MachineSummary; own: boolean; rowOf: (harness: string) => AgentRow | undefined };
  const subjects = new Map<string, RowSubject>();
  const attentionTextOf = (cells: Record<string, FleetMatrixCell>): string | null => {
    const items = harnesses.flatMap((harness) => {
      const entry = cells[harness];
      return entry?.kind === "agent" && entry.state === "attention" ? [mobileAttentionPhrase(harness, entry.label)] : [];
    });
    if (!items.length) return null;
    return items.length === 1 ? items[0]! : `${items[0]} · +${items.length - 1}`;
  };
  const mobileRows: MobileMatrixRow[] = [];
  const matrixRows: FleetMatrixRow[] = [
    ...model.ordered.map((machine): FleetMatrixRow => {
      const local = !machine || model.isThis(machine);
      const key = machine?.id ?? THIS_MACHINE_SELECTION;
      const name = machine ? model.nameOf(machine) : thisMachine!.name;
      const host = machine ? model.hostOf(machine) : undefined;
      const online = machine ? machine.status === "online" : thisMachine!.online;
      const stalled = Boolean(machine && machineUnresponsive(machine));
      const facts = [host ? `WSL on ${model.nameOf(host)}` : null,
        machine ? machineStateLine(machine, status.workingOn(machine)) : thisMachine!.summary,
        machine && !model.autoAssigned(machine) ? "Named only" : null].filter(Boolean).join(" · ");
      const items = machine ? inventoryOf(machine) : undefined;
      const machineId = machine ? machine.machineId : thisMachine?.machineId;
      const rowOf = (harness: string) => rows.find((candidate) => candidate.harness === harness && Boolean(machineId)
        && candidate.registration.key.machineId === machineId);
      const cells = cellsOf(key, (harness) => {
        const row = rowOf(harness);
        if (row) return agentCell(row);
        const item = items?.find((entry) => entry.id === harness);
        if (!machine || !item) return { kind: "unknown" };
        return item.installed ? { kind: "off" } : item.probeStatus === "unsupported" ? { kind: "unsupported" } : { kind: "absent" };
      });
      const loadAlerts = machine && online && machine.daemon
        ? machineGlanceReadings(machineLoadReadings(machineResourceObservation(machine.daemon.metadata?.machineResources, now)))
          .filter((reading) => meterTone(reading.percent) !== "green")
        : [];
      const os = machineOs(local ? thisMachine!.platform : machinePlatform(machine!));
      const openThisMachine = () => { setCell(null); openMachine(machine); };
      subjects.set(key, { name, machine: machine ?? undefined, own: Boolean(items), rowOf });
      mobileRows.push({
        key, name, os, own: Boolean(items), online, stalled, dimmed: !online,
        localTag: local ? <ThisMachineTag label={model.thisLabel} /> : undefined,
        exception: stalled ? "Not responding" : attentionTextOf(cells),
        loadAlerts,
        quietNote: !online ? (machine ? machineStateLine(machine, 0) : "Offline") : host ? `WSL on ${model.nameOf(host)}` : null,
        onOpenMachine: openThisMachine,
        cells,
      });
      return {
        key, name, dimmed: !online,
        heading: (
          <button type="button" data-testid="machine-row" onClick={openThisMachine}
            className={cn(machineHeading, "rounded hover:bg-foreground/5", host && "pl-5")}>
            <span className="app-tool-state-icon shrink-0" data-state={stalled ? "attention" : online ? "running" : "offline"}
              aria-label={`${name}: ${stalled ? "not responding" : online ? "online" : "offline"}`} role="img">
              <MachineGlyph os={os} /></span>
            <span className="min-w-0 flex-1">
              <span className="app-list-row-title block truncate font-semibold">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {local && <ThisMachineTag label={model.thisLabel} />}{local && facts ? " · " : null}{facts}</span>
              {machine && <span className="mt-1 block empty:hidden"><MachineLoadGlance machine={machine} now={now} /></span>}
            </span>
          </button>
        ),
        cells,
      };
    }),
    // A machine the reader's list has no record of: named for what runs on it, with no page of its own to open.
    ...[...unlisted, ...teammates].map((section): FleetMatrixRow => {
      const mine = ownedByReader(section);
      const up = section.agents.some((row) => row.registration.live?.machine.online);
      const owners = [...new Set(section.agents.map((row) => row.registration.ownerName))].join(", ");
      const rowOf = (harness: string) => section.agents.find((candidate) => candidate.harness === harness);
      const cells = cellsOf(section.key, (harness) => {
        const row = rowOf(harness);
        return row ? agentCell(row) : { kind: "unknown" };
      });
      const os = machineOs(section.platform);
      subjects.set(section.key, { name: section.name, own: false, rowOf });
      mobileRows.push({
        key: section.key, name: section.name, os, own: false, online: up, dimmed: !up,
        group: mine ? undefined : "Teammates' machines",
        exception: attentionTextOf(cells),
        loadAlerts: [],
        quietNote: [mine ? null : owners, up ? null : "Offline"].filter(Boolean).join(" · ") || null,
        cells,
      });
      return {
        key: section.key, name: section.name, dimmed: !up, group: mine ? undefined : "Teammates' machines",
        heading: (
          <span className={machineHeading}>
            <span className="app-tool-state-icon shrink-0" data-state={up ? "running" : "offline"} aria-hidden="true">
              <MachineGlyph os={os} /></span>
            <span className="min-w-0 flex-1">
              <span className="app-list-row-title block truncate font-semibold">{section.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {[mine ? null : owners, up ? null : "Offline"].filter(Boolean).join(" · ")}</span>
            </span>
          </span>
        ),
        cells,
      };
    }),
  ];
  // The chosen cell's editor, and those of cells where something still runs: closing a slip does not stop an install.
  const editing = [...new Set([...(cell ? [cellKey(cell.row, cell.harness)] : []), ...Object.keys(doing)])];
  const editors: FleetMatrixEditor[] = editing.flatMap((id) => {
    const at = id.lastIndexOf("|");
    const rowKey = id.slice(0, at);
    const harness = id.slice(at + 1);
    const subject = subjects.get(rowKey);
    if (!subject) return [];
    const row = subject.rowOf(harness);
    return [{
      row: rowKey, harness, label: `${harness} on ${subject.name}`,
      node: (
        <FleetCellEditor harness={harness} machineName={subject.name} machine={subject.machine} own={subject.own} row={row}
          token={token} spaceId={spaceId} now={now} working={status.workingInstanceIds} conversationTitle={conversationTitle}
          onOperation={(what) => setDoing((current) => {
            if ((current[id] ?? null) === what) return current;
            const next = { ...current };
            if (what) next[id] = what;
            else delete next[id];
            return next;
          })}
          onOpenAgent={() => { setCell(null); if (row) onChangeView("agents", row.id); }}
          onOpenMachine={() => { setCell(null); if (subject.machine) openMachine(subject.machine); }}
          onOpenConversation={onOpenConversation} onClose={() => setCell(null)} />
      ),
    }];
  });

  // Each agent waiting on a person (and each unresponsive machine) already renders in amber ink inside its grid cell / row.
  const attentionCount = model.listed.filter(machineUnresponsive).length + rows.filter((row) => row.activity.state === "attention").length;
  const attentionNote = attentionCount > 0 && (
    <span className={statusInkClass("attention")} data-testid="fleet-attention-count">
      {" · "}{attentionCount} {attentionCount === 1 ? "needs" : "need"} attention</span>
  );

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
  // Another machine: the same connection a first machine makes, followed for that machine alone.
  const addMachine = <BringAgentsIn spaceId={spaceId} token={token} userId={currentUserId} surface="agents" another phone={phone} />;
  const addColumnConfig = {
    options: offered.map((preset) => ({ harness: preset.id, name: preset.displayName })),
    onAdd: (harness: string) => setAddedColumns((current) => current.includes(harness) ? current : [...current, harness]),
  };
  const addRowConfig = { open: addingMachine, onToggle: () => setAddingMachine(!addingMachine), content: addMachine };
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

  const notices = (
    <>
      {error && <p role="alert" className="mb-4 text-xs font-medium text-destructive">{error}</p>}
      {model.identityUnavailable && <p role="status" className="mb-4 text-xs text-muted-foreground">
        Update xMatrix to identify this computer and show its controls on the registered Machine.
      </p>}
    </>
  );

  const list = (
    <ToolList title="Agents">
      <div className="px-[var(--mobile-content-inset,1rem)] pt-2 pb-[calc(6.5rem+var(--app-safe-area-bottom))]">
        {setup ? bringIn : (
          <div className="space-y-4">
            {notices}
            {catalogError}
            {turnOn}
            {mobileRows.length === 0 ? (loading
              ? <ContentSkeleton label="Loading machines and agents" lines={4} />
              : <p className="text-sm text-muted-foreground">{ready ? "No machines yet." : "Choose a Space to see its machines and agents."}</p>)
              : <MobileAvatarMatrix columns={columns} rows={mobileRows} ownMachineCount={model.ordered.length}
                attentionCount={attentionCount} workingCount={status.workingCount}
                selected={cell} onSelect={setCell} editors={editors}
                addColumn={addColumnConfig} addRow={addRowConfig} />}
          </div>
        )}
      </div>
    </ToolList>
  );

  const page = awaitingAgent ? <ToolPaperScroll><ContentSkeleton label="Loading agent" lines={4} /></ToolPaperScroll>
    : view === "agents" ? (
      <AgentPaper spaceId={spaceId} token={token} currentUserId={currentUserId} chosen={chosenRow} group={chosenGroup}
        now={now} working={status.workingInstanceIds} fleet={fleet} conversationTitle={conversationTitle}
        machineOf={machineOf} backAlways={!phone} onBack={back ?? (() => selectAgent(null))}
        onRefetch={() => catalog.refetch()} onOpenMachine={openMachine}
        onOpenConversation={onOpenConversation} />
    ) : (
      <MachinePaper model={model} edits={edits} select={selectMachine} loading={false} token={token}
        spaceId={spaceId ?? undefined} thisMachine={thisMachine} backAlways={!phone} onBack={back}
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
          {notices}
          {/* The matrix shows each thing that waits on a person in its own cell, so no list repeats them here. */}
          <FleetOverview status={status} attention={[]} note={attentionNote}>
            {catalogError}
            {turnOn}
            <section aria-label="Machines and agents" className="space-y-3">
              {matrixRows.length === 0 ? (loading
                ? <ContentSkeleton label="Loading machines and agents" lines={4} />
                : <p className="text-sm text-muted-foreground">{ready ? "No machines yet." : "Choose a Space to see its machines and agents."}</p>)
                : <FleetMatrix columns={columns} rows={matrixRows} selected={cell} onSelect={setCell} editors={editors}
                  addColumn={addColumnConfig} addRow={addRowConfig} />}
              {matrixRows.length > 0 && columns.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Choose a cell to change that agent on that machine. <span className="font-semibold">Off</span>: installed, not turned on in this Space.{" "}
                  <span className="font-semibold">+</span>: not installed. <span className="font-semibold">—</span>: cannot run there.{" "}
                  The + after the last agent adds one; the last row adds a machine.
                </p>
              )}
            </section>
          </FleetOverview>
        </>}
      </ToolPaperScroll>
    </ToolSheet>
  );
}
