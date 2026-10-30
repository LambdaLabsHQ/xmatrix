"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { agentLaunchExecutable } from "@xmatrix/protocol";
import { openRepositoryToStar } from "./star-prompt";
import { connectorIcon } from "./connector-icon";
import { registrationStatus } from "./my-agents-registrations";
import {
  EmptyToolState,
  ErrorPanel,
  MachineVersionValue,
  removeMachine,
  renameMachine,
  setMachineAutoAssign,
} from "./workspace-admin-views";

import { takeGitHubConnectOutcome } from "@/lib/github-connect-return";
import type { HumanProfile } from "@xmatrix/protocol";

import {
  EVENT_ICONS,
} from "./workspace-shell-constants";

import {
  LocalManagedAgent,
  MachineSummary,
} from "./workspace-shell-helpers";

import {
} from "./workspace-shell-helpers-extra";

import {
  AppView,
  replaceBrowserPath,
} from "./workspace-shell-navigation";

import {
  eventLabel,
  formatTime,
  relativeTime,
} from "./workspace-shell-recovered";

import { daemonPresenceLabel } from "./machine-daemon-presence";
import { MachineLoadPanel } from "./machine-load-details";
import { MachineHarnessPanel } from "./machine-harness-panel";
import { MachineWorktreesPanel } from "./machine-worktrees-panel";
import {
  MachineListRow, machinePlatform, machineStateLine, machineUnresponsive, machinesWithHostsFirst,
} from "./machine-list-row";
import { machineOs } from "./machine-os";
import {
  ToolDetail, ToolDetailEmpty, ToolDetailSection, ToolFact, ToolFacts, ToolList, ToolListGroup, ToolListRow, ToolSplit,
  ToolStateDot,
} from "./tool-split";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  Clock,
  Download,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  MessageSquareText,
  Pencil,
  PlugZap,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Shield,
  Star,
  Terminal,
  Bot,
  Trash2,
  PowerOff,
  Users,
  Wrench,
} from "lucide-react";

import { ListSkeleton } from "./content-skeleton";

import { Input } from "@/components/ui/input";

import { Face } from "@/components/dashboard/face";
import { ListSectionHeading } from "./list-section-heading";

import {
  workspaceKey,
} from "@/components/dashboard/agent-workspaces";


import {
  type DesktopAgentPresetDiscovery,
  type DesktopContext,
  type DesktopDaemonStatus,
  type DesktopRuntimeCheckResult,
  type DesktopSetupStatus,
  type DesktopWorkspaceCandidate,
} from "@/lib/desktop/bridge";

import { groupConnectorsForList, orderConnectorsForList, type AppConnectorManifest } from "@/lib/app-connectors";
import { useViewSelection } from "./url-query-state";
import { ConnectorDetailPage } from "./connector-detail";
import { connectorGeneratesCredentials } from "./connector-credentials";

import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest, unexpectedResponse } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

import { cn } from "@/lib/utils";

import { statusChipClass } from "@/components/ui/status-tone";

import { APP_VIEW_SELECTION_FIELDS, WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import type {
  ObservabilityEvent,
  SerializedAppConnectorConnection,
  SerializedAppConnectorExecution,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";

// Semantic module extracted from workspace-app-shell (AST-safe)

// Mobile overflow hub: groups workspace administration and personal settings
// without presenting the mixed collection as a personal-profile destination.
export function MoreView({
  profile,
  platformAdmin,
  onChangeView,
  onReportIssue,
}: {
  profile: HumanProfile;
  /** Hub-reported operator capability; the admin route re-checks it. */
  platformAdmin?: boolean;
  onChangeView: (view: AppView) => void;
  /** Opens the GitHub issue form for a report. */
  onReportIssue?: () => void;
}) {
  const groups: Array<{
    label: string;
    items: Array<{
      key: string;
      label: string;
      description: string;
      icon?: React.ComponentType<{ className?: string }>;
      leading?: React.ReactNode;
      onSelect: () => void;
    }>;
  }> = [];

  const viewItem = (
    view: AppView,
    label: string,
    description: string,
    icon: React.ComponentType<{ className?: string }>,
  ) => ({ key: view, label, description, icon, onSelect: () => onChangeView(view) });

  groups.push(
    {
      label: "Account",
      items: [
        {
          key: "profile",
          label: profile.displayName,
          description: profile.handle ? `@${profile.handle}` : "Set up your @handle",
          // An icon's width, so your name starts where the other rows' names do.
          leading: (
            <Face of={{ kind: "user", id: profile.userId, name: profile.displayName }} size="xs" showKindBadge={false}
              className="-mx-0.5" />
          ),
          onSelect: () => onChangeView("profile"),
        },
        viewItem("settings", "Settings", "Appearance, secrets, and sign out", Settings),
      ],
    },
    {
      label: "Workspace",
      items: [
        viewItem("activity", "Activity", "Recent events across this workspace", Radio),
        viewItem("team", "Team", "Workspaces, invitations, and roles", Users),
        viewItem("apps", "Apps", "Connected tools and scoped permissions", PlugZap),
      ],
    },
    {
      label: "Operations",
      items: [
        viewItem("agents", "Agents", "Registered agents and where they run", Bot),
        viewItem("machines", "Machines", "Registered machines and daemons", Terminal),
        viewItem("automation", "Schedules", "Scheduled channel activity", Clock),
      ],
    },
  );

  /* The desktop rail's Help menu carries these; on a phone they live here. */
  groups.push({
    label: "Support",
    items: [
      ...(onReportIssue ? [{
        key: "report-issue",
        label: "Report an issue",
        description: "Tell us what is broken or missing on GitHub",
        icon: MessageSquareText,
        onSelect: onReportIssue,
      }] : []),
      {
        key: "star",
        label: "Star on GitHub",
        description: "Help other developers find xMatrix",
        icon: Star,
        onSelect: openRepositoryToStar,
      },
    ],
  });

  if (platformAdmin) {
    groups.push({
      label: "Platform",
      items: [
        viewItem("admin", "Platform admin", "Platform usage, users, Spaces, and the audit trail", Shield),
      ],
    });
  }

  /* Settings' list on its paper: section headings over plain list rows, no
     cards, boards or glass. You are the first row, as Slack's "You" is. */
  return (
    <div className="app-tool-detail-scroll app-below-band min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <ListSectionHeading label={group.label} />
            <ul>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <ToolListRow key={item.key} selected={false} onSelect={item.onSelect}
                    leading={item.leading ?? (Icon ? <Icon className="size-4 text-muted-foreground" /> : undefined)}
                    title={item.label} subtitle={item.description} />
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/* Discovery returns a path-sorted list that often includes `/` and home. Keep a
   short preview by default; the rest is one click away. */
const DISCOVERED_AGENT_WORKSPACE_COLLAPSED_LIMIT = 3;

/** One line of a This machine section: a leading mark, a name over a quiet line, and what to do with it. */
function LocalLine({ leading, title, detail, trailing, indented, quiet }: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  detail?: React.ReactNode;
  trailing?: React.ReactNode;
  indented?: boolean;
  /** Trailing controls belong to the line: shown on hover, and always where there is no hover. */
  quiet?: boolean;
}) {
  return (
    <li className={cn("group/line flex min-w-0 items-center gap-3", indented ? "py-1 pl-9" : "py-2.5")}>
      {leading && <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">{leading}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 text-sm">{title}</div>
        {detail && <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>}
      </div>
      {trailing && (
        <div className={cn("flex shrink-0 items-center gap-1", quiet
          && "opacity-100 md:opacity-0 md:group-hover/line:opacity-100 md:focus-within:opacity-100")}>
          {trailing}
        </div>
      )}
    </li>
  );
}

function DiscoveredAgentWorkspaceList({
  presetId,
  workspaces,
  importedWorkspacePaths,
  busy,
  onImportWorkspace,
}: {
  presetId: string;
  workspaces: DesktopWorkspaceCandidate[];
  importedWorkspacePaths: Set<string>;
  busy: string | null;
  onImportWorkspace: (candidate: DesktopWorkspaceCandidate) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (workspaces.length === 0) return null;

  const canExpand = workspaces.length > DISCOVERED_AGENT_WORKSPACE_COLLAPSED_LIMIT;
  const visibleWorkspaces =
    canExpand && !expanded
      ? workspaces.slice(0, DISCOVERED_AGENT_WORKSPACE_COLLAPSED_LIMIT)
      : workspaces;
  const hiddenCount = workspaces.length - visibleWorkspaces.length;

  return (
    <>
      {visibleWorkspaces.map((candidate) => {
        const workspaceImported = importedWorkspacePaths.has(candidate.canonicalCwd);
        const importing = busy === `workspace:import:${candidate.canonicalCwd}`;
        return (
          <LocalLine
            key={`${presetId}:${candidate.canonicalCwd}`}
            indented
            leading={<Folder className="size-4" />}
            title={(
              <>
                {candidate.displayName !== candidate.canonicalCwd && (
                  <span className="shrink-0 font-medium">{candidate.displayName}</span>
                )}
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={candidate.canonicalCwd}>
                  {candidate.canonicalCwd}
                </span>
              </>
            )}
            trailing={workspaceImported ? (
              <span className="flex items-center gap-1 px-2 text-xs text-muted-foreground"><Check className="size-3.5" /> Added</span>
            ) : (
              <Button size="xs" variant="ghost" disabled={importing} onClick={() => onImportWorkspace(candidate)}>
                {importing ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Plus />} Add
              </Button>
            )}
          />
        );
      })}
      {canExpand && (
        <li className="py-1.5 pl-9">
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            className="inline-flex h-6 items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
            {expanded ? "Show less" : `Show ${hiddenCount} more`}
          </button>
        </li>
      )}
    </>
  );
}

/** This machine, read on the paper like any other Machine: sections of lines, no cards. */
export function LocalMacView({
  desktopAvailable,
  desktopContext,
  desktopDaemonStatus,
  desktopSetupStatus,
  workspaces,
  agents,
  discoveries,
  loadingDiscoveries,
  busy,
  error,
  runtimeCheck,
  setupReady,
  machineName,
  onNameMachine,
  harnesses,
  worktrees,
  hubRecord,
  onStartDaemon,
  onRestartDaemon,
  onOpenCliInstall,
  onRefreshDiscoveries,
  onAddWorkspace,
  onImportAgent,
  onImportWorkspace,
  onRemoveWorkspace,
  onRevealWorkspace,
  onCreateAgent,
  onEditAgent,
  onDeleteAgent,
  onCheckRuntime,
  onCompleteSetup,
}: {
  desktopAvailable: boolean;
  desktopContext: DesktopContext | null;
  desktopDaemonStatus: DesktopDaemonStatus | null;
  desktopSetupStatus: DesktopSetupStatus | null;
  workspaces: SerializedWorkspace[];
  agents: LocalManagedAgent[];
  discoveries: DesktopAgentPresetDiscovery[];
  loadingDiscoveries: boolean;
  busy: string | null;
  error: string | null;
  runtimeCheck: DesktopRuntimeCheckResult | null;
  setupReady: boolean;
  machineName: string | null | undefined;
  onNameMachine: (name: string) => void;
  /** The machine's harness inventory, shown after its daemon as on every Machine's page. */
  harnesses?: React.ReactNode;
  /** The Machine's git worktrees; renders its own section. */
  worktrees?: React.ReactNode;
  /** The Hub's record of this machine: more daemon facts and its load. */
  hubRecord?: { facts: React.ReactNode; load: React.ReactNode } | null;
  onStartDaemon: () => void;
  onRestartDaemon: () => void;
  onOpenCliInstall: () => void;
  onRefreshDiscoveries: () => void;
  onAddWorkspace: () => void;
  onImportAgent: (discovery: DesktopAgentPresetDiscovery) => void;
  onImportWorkspace: (candidate: DesktopWorkspaceCandidate) => void;
  onRemoveWorkspace: (workspace: SerializedWorkspace) => void;
  onRevealWorkspace: (workspace: SerializedWorkspace) => void;
  onCreateAgent: () => void;
  onEditAgent: () => void;
  onDeleteAgent: (agent: LocalManagedAgent) => void;
  onCheckRuntime: (runtime: string) => void;
  onCompleteSetup: () => void;
}) {
  const [nameDraft, setNameDraft] = useState("");
  const setupComplete = Boolean(desktopSetupStatus?.completedAt) && Boolean(machineName);
  const daemonState = desktopDaemonStatus?.state;
  const daemonRunning = daemonState === "running";
  const daemonStarting = daemonState === "starting";
  const importedWorkspacePaths = new Set(workspaces.map((workspace) => workspace.canonicalCwd));
  const importedPresetIds = new Set(agents.map((agent) => agent.harness));
  const setupSteps = [
    { label: "Sign in", done: desktopAvailable },
    { label: "Name this machine", done: Boolean(machineName) },
    { label: "Start the daemon", done: daemonRunning },
    { label: "Add a local directory", done: workspaces.length > 0 },
    { label: "Add a local agent", done: agents.length > 0 },
  ];

  if (!desktopAvailable) {
    return (
      <div className="space-y-5">
        <EmptyToolState icon={HardDrive} title="Desktop bridge unavailable" body="Open xMatrix from the desktop app to manage local agents and directories." />
      </div>
    );
  }

  const iconButton = "text-muted-foreground hover:text-foreground";

  return (
    <>
      {error && <ErrorPanel title="Local action failed" error={error} />}

      {!setupComplete && (
        <ToolDetailSection
          title="Set up this machine"
          action={(
            <Button size="xs" disabled={!setupReady || busy === "setup:complete"} onClick={onCompleteSetup}>
              {busy === "setup:complete" ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Check />}
              Complete setup
            </Button>
          )}
        >
          {!machineName && (
            <form className="mb-4 flex max-w-md items-end gap-2" onSubmit={event => {
              event.preventDefault();
              if (nameDraft.trim()) onNameMachine(nameDraft.trim());
            }}>
              <label className="flex-1 space-y-1 text-sm">
                <span>Machine name</span>
                <Input aria-label="Name this machine" value={nameDraft} onChange={event => setNameDraft(event.target.value)}
                  placeholder="For example, Laptop" maxLength={64} required
                  disabled={!desktopContext?.machineId || machineName === undefined || busy === "machine:name"} />
              </label>
              <Button type="submit" size="sm" disabled={!nameDraft.trim() || machineName === undefined || busy === "machine:name"}>
                {busy === "machine:name" ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : null} Save name
              </Button>
            </form>
          )}
          <ol className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
            {setupSteps.map((step) => (
              <li key={step.label} className={cn("flex items-center gap-2", !step.done && "text-muted-foreground")}>
                {step.done ? <Check className="size-4 shrink-0" /> : <Circle className="size-3.5 shrink-0" />}
                {step.label}
              </li>
            ))}
          </ol>
        </ToolDetailSection>
      )}

      <ToolDetailSection
        title="Daemon"
        action={daemonState === "missing" ? (
          <Button size="xs" variant="outline" onClick={onOpenCliInstall}><Download /> Install CLI</Button>
        ) : daemonRunning ? (
          <Button size="xs" variant="ghost" disabled={daemonStarting} onClick={onRestartDaemon}><RefreshCw /> Restart</Button>
        ) : (
          <Button size="xs" variant="outline" disabled={daemonStarting || !machineName} onClick={onStartDaemon}>
            {daemonStarting ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Radio />}
            {daemonStarting ? "Starting" : "Start"}
          </Button>
        )}
      >
        <ToolFacts>
          <ToolFact label="Status">
            <span className="flex items-center gap-2">
              <ToolStateDot state={daemonRunning ? "running" : daemonState === "error" || daemonState === "missing" ? "attention" : "offline"} />
              {desktopDaemonLabel(desktopDaemonStatus, desktopAvailable)}
            </span>
          </ToolFact>
          <ToolFact label="Hostname">{desktopContext?.hostname || desktopContext?.hostName || desktopContext?.hostId || "-"}</ToolFact>
          {hubRecord?.facts}
        </ToolFacts>
        {!daemonRunning && (
          <p className="mt-2 max-w-prose text-xs text-muted-foreground">
            {desktopDaemonStatus?.message || "The daemon keeps this machine reachable for directory launches."}
          </p>
        )}
        {hubRecord?.load}
      </ToolDetailSection>

      {harnesses && <ToolDetailSection title="Harnesses">{harnesses}</ToolDetailSection>}
      {worktrees}

      <ToolDetailSection
        title={`Agents · ${agents.length}`}
        concealAction={agents.length > 0}
        action={<Button size="xs" variant="ghost" onClick={onCreateAgent}><Plus /> New agent</Button>}
      >
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent on this machine in this Space yet. Add one below from what was found, or create one.</p>
        ) : (
          <ul className="app-tool-lines">
            {agents.map((agent) => {
              const agentStatus = registrationStatus(agent.registration);
              const runtime = agentLaunchExecutable(agent.harness);
              return (
                <LocalLine
                  key={agent.id}
                  quiet
                  leading={(
                    <Face of={{ kind: "agent", name: agent.name, harness: agent.harness }} size="sm" showKindBadge={false} />
                  )}
                  title={(
                    <>
                      <span className="truncate font-semibold">{agent.name}</span>
                      {agentStatus && <span className={statusChipClass(agentStatus.tone, "shrink-0")}>{agentStatus.label}</span>}
                    </>
                  )}
                  detail={<span className="font-mono">{agent.harness}</span>}
                  trailing={(
                    <>
                      <Button size="icon-sm" variant="ghost" className={iconButton} title="Check runtime"
                        aria-label="Check runtime" disabled={busy === `runtime:${runtime}`} onClick={() => onCheckRuntime(runtime)}>
                        <Wrench />
                      </Button>
                      <Button size="icon-sm" variant="ghost" className={iconButton} title="Edit agent" aria-label="Edit agent"
                        onClick={onEditAgent}>
                        <Pencil />
                      </Button>
                      {agent.registration.canConfigureSpace && agent.registration.state === "enabled" && (
                        <Button size="icon-sm" variant="ghost" className={iconButton} title="Disable" aria-label="Disable"
                          onClick={() => onDeleteAgent(agent)}>
                          <PowerOff />
                        </Button>
                      )}
                    </>
                  )}
                />
              );
            })}
          </ul>
        )}
        {runtimeCheck && (
          <p className={cn("mt-2 text-xs", runtimeCheck.ok ? "text-muted-foreground" : "text-destructive")} role="status">
            {runtimeCheck.ok
              ? `${runtimeCheck.runtime} is available${runtimeCheck.version ? `: ${runtimeCheck.version}` : ""}`
              : `${runtimeCheck.runtime || "Runtime"} unavailable: ${runtimeCheck.error || "not found"}`}
          </p>
        )}
      </ToolDetailSection>

      <ToolDetailSection
        title={`Directories · ${workspaces.length}`}
        concealAction={workspaces.length > 0}
        action={(
          <Button size="xs" variant="ghost" disabled={busy === "workspace:add"} onClick={onAddWorkspace}>
            {busy === "workspace:add" ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Plus />} Add directory
          </Button>
        )}
      >
        {workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">No local directory on this machine yet. Add one, or pick one an agent already works in below.</p>
        ) : (
          <ul className="app-tool-lines">
            {workspaces.map((workspace) => {
              const removing = busy === `workspace:remove:${workspaceKey(workspace)}`;
              return (
                <LocalLine
                  key={workspaceKey(workspace)}
                  quiet
                  leading={<Folder className="size-4" />}
                  title={<span className="truncate font-semibold">{workspace.displayName}</span>}
                  detail={(
                    <>
                      <span className="font-mono" title={workspace.canonicalCwd}>{workspace.canonicalCwd}</span>
                      {workspace.runtimesSeen?.length ? <span> · {workspace.runtimesSeen.join(", ")}</span> : null}
                    </>
                  )}
                  trailing={(
                    <>
                      <Button size="icon-sm" variant="ghost" className={iconButton} title="Reveal in Finder"
                        aria-label="Reveal in Finder" onClick={() => onRevealWorkspace(workspace)}>
                        <FolderOpen />
                      </Button>
                      <Button size="icon-sm" variant="ghost" className={iconButton} title="Remove local directory"
                        aria-label="Remove local directory" disabled={removing} onClick={() => onRemoveWorkspace(workspace)}>
                        {removing ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Trash2 />}
                      </Button>
                    </>
                  )}
                />
              );
            })}
          </ul>
        )}
      </ToolDetailSection>

      <ToolDetailSection
        title="Found on this machine"
        concealAction={discoveries.length > 0 && !loadingDiscoveries}
        action={(
          <Button size="icon-xs" variant="ghost" className={iconButton} onClick={onRefreshDiscoveries}
            disabled={loadingDiscoveries} title="Scan again" aria-label="Scan again">
            <AnimatedIcon icon={RefreshCw} className={cn(loadingDiscoveries && "animate-spin")} />
          </Button>
        )}
      >
        {discoveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {loadingDiscoveries ? "Scanning for Codex and Claude Code…" : "No Codex or Claude Code setup found on this machine."}
          </p>
        ) : (
          <ul className="app-tool-lines">
            {discoveries.map((discovery) => {
              const agentImported = importedPresetIds.has(discovery.presetId);
              const importing = busy === `agent:import:${discovery.presetId}`;
              const configDirs = discovery.configDirs.join(", ");
              return (
                <li key={discovery.presetId} className="py-1">
                  <ul>
                    <LocalLine
                      leading={(
                        <Face of={{ kind: "agent", name: discovery.displayName, harness: discovery.presetId }} size="sm"
                          showKindBadge={false} />
                      )}
                      title={(
                        <>
                          <span className="truncate font-semibold">{discovery.displayName}</span>
                          <span className="flex shrink-0 items-center gap-1.5 self-center text-xs text-muted-foreground">
                            <ToolStateDot state={discovery.runtimeAvailable ? "running" : "attention"} />
                            {discovery.runtimeAvailable ? "Installed" : "Not installed"}
                          </span>
                        </>
                      )}
                      detail={(
                        <span className="font-mono" title={configDirs}>
                          {discovery.backend}{configDirs ? ` · ${configDirs}` : ""}
                        </span>
                      )}
                      trailing={agentImported ? (
                        <span className="flex items-center gap-1 px-2 text-xs text-muted-foreground"><Check className="size-3.5" /> Added</span>
                      ) : (
                        <Button size="xs" variant="outline" disabled={importing} onClick={() => onImportAgent(discovery)}>
                          {importing ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Plus />} Add agent
                        </Button>
                      )}
                    />
                    <DiscoveredAgentWorkspaceList
                      presetId={discovery.presetId}
                      workspaces={discovery.workspaces}
                      importedWorkspacePaths={importedWorkspacePaths}
                      busy={busy}
                      onImportWorkspace={onImportWorkspace}
                    />
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </ToolDetailSection>

      <ToolDetailSection title="From the terminal">
        <ul className="app-tool-lines text-sm">
          {[
            ["xmatrix workspace list", "The same local directories"],
            ["xmatrix agent list", "The same local agents"],
            ["~/.config/xmatrix/agents.json", "Runtimes, environment and secrets for this machine"],
          ].map(([command, description]) => (
            <li key={command} className="flex min-w-0 flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-4">
              <code className="min-w-0 font-mono text-xs text-foreground sm:w-64 sm:shrink-0 [overflow-wrap:anywhere]">{command}</code>
              <span className="min-w-0 text-xs text-muted-foreground">{description}</span>
            </li>
          ))}
        </ul>
      </ToolDetailSection>
    </>
  );
}

/**
 * The Space's Machines, read like every rail destination: the list names
 * each host (its WSL guests under it) and the paper shows the one chosen.
 * On the desktop app its own machine is listed like any other, only tagged
 * "This machine": its local setup — daemon, directories, local agents — is
 * that row's page.
 */
export function MachinesView({
  machines,
  loading,
  error,
  token,
  spaceId,
  thisMachine,
  defaultMachineId,
}: {
  machines: MachineSummary[];
  loading: boolean;
  error: string | null;
  token?: string | null;
  /** The Space being viewed: an owner turns each installed harness on or off for it. */
  spaceId?: string;
  /** The desktop app's own machine: its row's state and its page. */
  thisMachine?: {
    machineId?: string;
    /** Its name until the Hub's record of it is listed. */
    name: string;
    summary: string;
    online: boolean;
    /** The desktop app's platform (`win32` / `darwin` / `linux`) for its OS mark. */
    platform?: string;
    /** Its page, given the Hub's record of it (versions, last seen, load) to show beside the daemon. */
    content: (hubRecord: { facts: React.ReactNode; load: React.ReactNode } | null) => React.ReactNode;
  } | null;
  /** The Machine shown when the address names none (this machine, opened from setup). */
  defaultMachineId?: string;
}) {
  // A saved name shows at once; the next Machine refresh carries it too.
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ machineId: string; draft: string; create?: boolean } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const skipSave = useRef(false);
  const savingName = useRef(false);
  // A removed Machine leaves the list at once; the next Machine refresh omits it too.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // A saved assignment choice shows at once; the next Machine refresh carries it too.
  const [assigned, setAssigned] = useState<Record<string, boolean>>({});
  const [assignBusy, setAssignBusy] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [selectedMachineId, select] = useViewSelection("machines");
  // Load samples expire after 90 seconds; re-judge freshness between refreshes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const nameOf = (machine: MachineSummary) => (machine.machineId && renamed[machine.machineId]) || machine.name;
  const hostOf = (machine: MachineSummary) => machines.find((host) =>
    host.machineId && host.machineId === machine.parentMachineId);
  const saveName = async () => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    if (!editing || !token || savingName.current) return;
    const machine = machines.find((candidate) => candidate.machineId === editing.machineId);
    const next = editing.draft.trim();
    if (!next || (machine && !editing.create && next === nameOf(machine))) {
      setEditing(null);
      return;
    }
    savingName.current = true;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const name = await renameMachine(token, editing.machineId, next, editing.create);
      setRenamed((current) => ({ ...current, [editing.machineId]: name }));
      setEditing(null);
    } catch (reason) {
      setRenameError(userErrorMessage(reason, "Couldn't rename the Machine"));
    } finally {
      savingName.current = false;
      setRenameBusy(false);
    }
  };
  const autoAssigned = (machine: MachineSummary): boolean => machine.machineId !== undefined && machine.machineId in assigned
    ? assigned[machine.machineId]! : machine.autoAssign !== false;
  const assign = async (machine: MachineSummary, on: boolean) => {
    const machineId = machine.machineId;
    if (!token || !machineId || assignBusy) return;
    setAssignBusy(machineId);
    setAssignError(null);
    try {
      const saved = await setMachineAutoAssign(token, machineId, on);
      setAssigned((current) => ({ ...current, [machineId]: saved }));
    } catch (reason) {
      setAssignError(userErrorMessage(reason, "Couldn't change automatic assignment"));
    } finally {
      setAssignBusy(null);
    }
  };
  const remove = async (machine: MachineSummary) => {
    const machineId = machine.machineId;
    if (!token || !machineId || removingId) return;
    if (!window.confirm(`Remove ${nameOf(machine)}? Every agent running on it stops and it leaves your Machines. `
      + "Run `xmatrix login` on it to add it back.")) return;
    setRemovingId(machineId);
    setRemoveError(null);
    try {
      await removeMachine(token, machineId);
      setRemoved((current) => new Set(current).add(machineId));
      setEditing(null);
      select(null);
    } catch (reason) {
      setRemoveError(userErrorMessage(reason, "Couldn't remove the Machine"));
    } finally {
      setRemovingId(null);
    }
  };
  const identityUnavailable = Boolean(thisMachine) && (!thisMachine?.machineId ||
    /^machine:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(thisMachine.machineId));
  // The desktop's own record is exactly the one with its Machine id; nothing else stands in for it.
  const isThis = (machine: MachineSummary) => Boolean(thisMachine?.machineId)
    && machine.machineId === thisMachine?.machineId;
  const listed = machinesWithHostsFirst(machines.filter((machine) =>
    !(machine.machineId && removed.has(machine.machineId))));
  const thisRecord = listed.find(isThis);
  // This machine is a row like any other; until the Hub lists it, it leads the list under its own name.
  const ordered = thisMachine && !identityUnavailable && !thisRecord ? [null, ...listed] : listed;
  const chosenKey = selectedMachineId ?? defaultMachineId ?? null;
  const showingThis = Boolean(thisMachine) && (chosenKey === THIS_MACHINE_SELECTION
    || Boolean(thisRecord && chosenKey === thisRecord.id));
  const chosen = showingThis ? null : listed.find((machine) => machine.id === chosenKey);
  const shown = showingThis ? null : chosen ?? (thisMachine ? null : listed[0]);
  const showThisBeside = Boolean(thisMachine) && !showingThis && !chosen;
  // This machine is said, not boxed: in ink at the head of its quiet line, where every other Machine says less.
  // Called what its OS calls it: This Mac, This PC; any other OS is "This Machine", capitalised alike.
  const thisOs = thisMachine ? machineOs(thisMachine.platform) : "unknown";
  const thisLabel = thisOs === "macos" ? "This Mac" : thisOs === "windows" ? "This PC" : "This Machine";
  const thisTag = <span className="font-semibold text-foreground" data-testid="this-machine-tag">{thisLabel}</span>;

  const list = (
    <ToolList title="Machines">
      {error && <p role="alert" className="px-5 pb-2 text-xs font-medium text-destructive md:px-6">{error}</p>}
      {identityUnavailable && <p role="status" className="px-5 pb-2 text-xs text-muted-foreground md:px-6">
        Update xMatrix to identify this computer and show its controls on the registered Machine.
      </p>}
      <ul>
        {loading && ordered.length === 0 ? (
          <li className="list-none"><ListSkeleton label="Loading machines" rows={4} /></li>
        ) : ordered.length === 0 ? (
          <li className="px-5 py-2 text-sm text-muted-foreground md:px-6">No machines registered.</li>
        ) : ordered.map((machine) => {
          // This machine is a row like any other, only tagged; before the Hub lists it, the desktop says its state.
          const local = !machine || isThis(machine);
          const name = machine ? nameOf(machine) : thisMachine!.name;
          const host = machine ? hostOf(machine) : undefined;
          const online = machine ? machine.status === "online" : thisMachine!.online;
          const facts = [host ? `WSL on ${nameOf(host)}` : null,
            machine ? machineStateLine(machine) : thisMachine!.summary,
            machine && !autoAssigned(machine) ? "Named only" : null].filter(Boolean).join(" · ");
          return (
            <MachineListRow key={machine?.id ?? THIS_MACHINE_SELECTION} machine={machine} name={name}
              platform={local ? thisMachine!.platform : machinePlatform(machine!)} online={online} hosted={Boolean(host)}
              selected={local ? showingThis : machine!.id === chosen?.id}
              shownBeside={local ? showThisBeside && !selectedMachineId
                : !chosen && !showingThis && !showThisBeside && machine!.id === shown?.id}
              onSelect={() => select(local ? THIS_MACHINE_SELECTION : machine!.id)}
              now={now}
              subtitle={local ? <>{thisTag}{facts ? <> · {facts}</> : null}</> : facts} />
          );
        })}
      </ul>
    </ToolList>
  );

  // This machine's page is a Machine's page with its local controls: the Hub's record when listed, the desktop's own otherwise.
  const pageMachine = showingThis || showThisBeside ? thisRecord ?? null : shown;
  const local = Boolean(thisMachine) && (showingThis || showThisBeside);
  let detail: React.ReactNode = null;
  if (pageMachine || local) {
    const machine = pageMachine;
    const host = machine ? hostOf(machine) : undefined;
    const name = machine ? nameOf(machine) : thisMachine!.name;
    const unnamed = name === "Unnamed machine";
    const renaming = Boolean(machine && editing && machine.machineId && editing.machineId === machine.machineId);
    const online = machine ? machine.status === "online" : thisMachine!.online;
    const stalled = Boolean(machine && machineUnresponsive(machine));
    const titleControl = "flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50";
    detail = (
      <ToolDetail
        key={machine?.id ?? THIS_MACHINE_SELECTION}
        onBack={() => select(null)}
        backLabel="Machines"
        context="Machines"
        title={renaming && editing ? (
          <form className="w-full" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
            <input
              aria-label="Machine name"
              value={editing.draft}
              maxLength={64}
              autoFocus
              disabled={renameBusy}
              placeholder="Machine name"
              onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
              onBlur={() => void saveName()}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                skipSave.current = true;
                setRenameError(null);
                setEditing(null);
              }}
              className="w-full border-0 border-b border-foreground/25 bg-transparent text-2xl font-black leading-none text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-foreground"
            />
          </form>
        ) : <span className="[overflow-wrap:anywhere]">{name}</span>}
        titleAccessory={token && machine?.machineId && !renaming ? (
          <>
            <button type="button" className={titleControl}
              title={unnamed ? "Name it" : "Rename"}
              aria-label={unnamed ? "Name it" : "Rename"}
              onClick={() => { setRenameError(null); setEditing({ machineId: machine.machineId!,
                draft: unnamed ? "" : name, create: unnamed }); }}>
              {renameBusy ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <Pencil className="size-4" />}
            </button>
            <button type="button" className={cn(titleControl, "hover:text-destructive")}
              title={`Remove ${name}`}
              aria-label={`Remove ${name}`}
              disabled={Boolean(removingId)}
              onClick={() => void remove(machine)}>
              {removingId === machine.machineId ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </button>
          </>
        ) : undefined}
        status={
          <span className="flex flex-wrap items-center gap-x-2">
            <ToolStateDot state={stalled ? "attention" : online ? "running" : "offline"} />
            <span className="capitalize text-foreground">{stalled ? "not responding" : online ? "online" : "offline"}</span>
            <span>· {local ? thisTag : null}{local && host ? " · " : null}{host ? `WSL on ${nameOf(host)}` : local ? null : "machine"}</span>
            {/* While online, the stored time is its last connection, not a heartbeat. */}
            {machine?.lastSeenAt && <span>· {online ? "connected" : "seen"} {relativeTime(machine.lastSeenAt)}</span>}
            {stalled && machine?.daemon?.unansweredSince && <span>· work waiting since {relativeTime(machine.daemon.unansweredSince)}</span>}
          </span>
        }
      >
        {renaming && renameError && <p className="text-sm text-destructive">{renameError}</p>}
        {removeError && <p role="alert" className="text-sm text-destructive">{removeError}</p>}
        {token && machine?.machineId && (
          <ToolDetailSection title="Assignment">
            <ToolFacts>
              <ToolFact label="Automatic assignment">
                <span className="inline-flex items-center gap-2">
                  <Switch checked={autoAssigned(machine)} disabled={assignBusy === machine.machineId}
                    label={`Automatic assignment: ${name}`} onChange={(on) => void assign(machine, on)} />
                  <span className="text-muted-foreground">{autoAssigned(machine)
                    ? "Agents may start here whenever it suits the work"
                    : `Agents start here only when named, e.g. machine:${name}`}</span>
                </span>
              </ToolFact>
            </ToolFacts>
            {assignError && <p role="alert" className="text-sm text-destructive">{assignError}</p>}
          </ToolDetailSection>
        )}
        {local ? thisMachine!.content(machine ? {
          facts: (
            <>
              <MachineVersionFacts machine={machine} />
            </>
          ),
          load: <MachineLoadPanel machine={machine} now={now} token={token} />,
        } : null) : machine && (
          <>
            <ToolDetailSection title="Daemon">
              <ToolFacts>
                <ToolFact label="Daemon">{daemonPresenceLabel(machine.daemon)}</ToolFact>
                <MachineVersionFacts machine={machine} />
              </ToolFacts>
              <MachineLoadPanel machine={machine} now={now} token={token} />
            </ToolDetailSection>
            <ToolDetailSection title="Harnesses">
              <MachineHarnessPanel key={`${spaceId}:${machine.id}`} daemon={machine.daemon} token={token} spaceId={spaceId} />
            </ToolDetailSection>
            <MachineWorktreesPanel key={`worktrees:${machine.id}`} daemon={machine.daemon} token={token} />
            <ToolDetailSection title={`Directories · ${machine.workspaces.length}`}>
              {machine.workspaces.length === 0 ? (
                <p className="text-sm text-muted-foreground">No directories registered on this machine.</p>
              ) : (
                <ul className="app-tool-lines">
                  {machine.workspaces.map((workspace) => (
                    <li key={workspaceKey(workspace)} className="flex min-w-0 items-center gap-2 py-1.5 text-sm">
                      <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-xs">{workspace.displayName}</span>
                    </li>
                  ))}
                </ul>
              )}
            </ToolDetailSection>
          </>
        )}
      </ToolDetail>
    );
  } else if (!loading) {
    detail = (
      <ToolDetailEmpty icon={<Terminal />} title="No machines registered">
        <p>Start xmatrix daemon on a host or register a workspace from a local directory.</p>
      </ToolDetailEmpty>
    );
  }

  return <ToolSplit label="Machines" open={Boolean(selectedMachineId)} list={list} detail={detail} />;
}

/** The address key of the desktop app's own machine in the Machines list. */
export const THIS_MACHINE_SELECTION = "this-machine";

const NO_CONNECTIONS: SerializedAppConnectorConnection[] = [];
const NO_EXECUTIONS: SerializedAppConnectorExecution[] = [];

export function AppsView({
  connectors: catalog,
  currentSpace,
  token,
}: {
  connectors: AppConnectorManifest[];
  currentSpace: SerializedSpace | null;
  token?: string;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // The address is the only source of the selected connector.
  const [connectorId, selectConnector] = useViewSelection("apps");
  const setSelectedConnectorId = (id: string) => selectConnector(id, { replace: true });
  const [connectionActionError, setConnectionsError] = useState<string | null>(null);
  const [setupNotice, setSetupNotice] = useState<{ tone: "success" | "warning"; message: string } | null>(null);
  const [executionActionError, setExecutionsError] = useState<string | null>(null);
  const [updatingProviderId, setUpdatingProviderId] = useState<string | null>(null);
  const [disconnectingProviderId, setDisconnectingProviderId] = useState<string | null>(null);
  const [checkingProviderId, setCheckingProviderId] = useState<string | null>(null);
  const connectionKey = xmatrixQueryKeys.domain(
    { userId: user?.id ?? "anonymous" }, "app-connections", [currentSpace?.id ?? null],
  );
  const executionKey = xmatrixQueryKeys.domain(
    { userId: user?.id ?? "anonymous" }, "app-executions", [currentSpace?.id ?? null],
  );
  const connectionsQuery = useQuery({
    queryKey: connectionKey,
    queryFn: ({ signal }) => xmatrixApiRequest<{
      connections?: SerializedAppConnectorConnection[];
    }>({
      url: WEB_PROXY_ROUTES.space_app_connections(currentSpace!.id), token, signal,
    }).then((payload) => payload.connections ?? []),
    enabled: Boolean(token && currentSpace && user?.id),
  });
  const executionsQuery = useQuery({
    queryKey: executionKey,
    queryFn: ({ signal }) => xmatrixApiRequest<{
      executions?: SerializedAppConnectorExecution[];
    }>({
      url: WEB_PROXY_ROUTES.space_app_executions(currentSpace!.id), token, signal,
    }).then((payload) => payload.executions ?? []),
    enabled: Boolean(token && currentSpace && user?.id),
  });
  /* Providers whose one-click OAuth this Hub has configured. */
  const oauthProvidersQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "connector-oauth-providers", [currentSpace?.id ?? ""]),
    queryFn: ({ signal }) => xmatrixApiRequest<{ providers?: string[]; nativeProviders?: string[] }>({
      url: currentSpace
        ? `${WEB_PROXY_ROUTES.connector_oauth_providers}?spaceId=${encodeURIComponent(currentSpace.id)}`
        : WEB_PROXY_ROUTES.connector_oauth_providers,
      token, signal,
    }).then((payload) => ({ providers: payload.providers ?? [], nativeProviders: payload.nativeProviders ?? [] })),
    enabled: Boolean(token && user?.id && currentSpace),
  });
  const oauthProviders = oauthProvidersQuery.data?.providers ?? [];
  const nativeProviders = oauthProvidersQuery.data?.nativeProviders ?? [];
  const connectionMutation = useMutation({
    mutationKey: [...connectionKey, "command"],
    mutationFn: (input: { url: string; method?: string; body?: unknown }) =>
      xmatrixApiRequest<{
        connection?: SerializedAppConnectorConnection;
        message?: string;
        url?: string;
      }>({
        url: input.url,
        method: input.method,
        token,
        body: input.body,
      }),
  });
  const connections = connectionsQuery.data ?? NO_CONNECTIONS;
  const connectors = useMemo(() => orderConnectorsForList(catalog, connections), [catalog, connections]);
  const selectedConnectorId = connectorId ?? connectors[0]?.id ?? "";
  const executions = executionsQuery.data ?? NO_EXECUTIONS;
  const connectionsError = connectionActionError ?? userErrorMessage(connectionsQuery.error, "Couldn't load app connections");
  const executionsError = executionActionError ?? userErrorMessage(executionsQuery.error, "Couldn't load app actions");
  const loadingExecutions = executionsQuery.isFetching;
  const setConnections = useCallback((update: (
    current: SerializedAppConnectorConnection[],
  ) => SerializedAppConnectorConnection[]) => {
    queryClient.setQueryData<SerializedAppConnectorConnection[]>(
      connectionKey, (current = []) => update(current),
    );
  }, [connectionKey, queryClient]);
  const selectedConnector = connectors.find((connector) => connector.id === selectedConnectorId) || connectors[0];
  const connectionsByProvider = useMemo(
    () => new Map(connections.map((connection) => [connection.providerId, connection])),
    [connections]
  );
  const selectedConnection = selectedConnector ? connectionsByProvider.get(selectedConnector.id) : undefined;
  const selectedExecutions = useMemo(
    () => executions.filter((execution) => execution.providerId === selectedConnector?.id).slice(0, 6),
    [executions, selectedConnector?.id]
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("item");
    const outcome = url.searchParams.get("oauth");
    const providerId = url.searchParams.get(APP_VIEW_SELECTION_FIELDS.apps);
    if (providerId === "gmail" && (url.searchParams.has("gmailWatchState") || url.searchParams.has("gmailWatch"))) {
      // The mailbox view consumes its single-use code after connection data loads.
      // The connector in the address already opens Gmail; do not claim the grant completed.
      if (url.searchParams.get("gmailWatch") === "failed") {
        setSetupNotice({ tone: "warning", message: "Gmail notification authorization did not finish. Turn notifications on to try again." });
        url.searchParams.delete("gmailWatch");
      }
      replaceBrowserPath(`${url.pathname}${url.search}${url.hash}`);
      return;
    }
    if (!outcome || !providerId) return;
    const name = connectors.find((connector) => connector.id === providerId)?.name ?? providerId;
    setSetupNotice(outcome === "connected"
      ? { tone: "success", message: providerId === "x"
        ? "X account connected. Confirm its handle below and use Add X account to authorize your other account."
        : `${name} is connected. Subscribe a channel or allow its actions below.` }
      : outcome === "elsewhere"
      ? { tone: "warning", message: `This ${name} workspace is already connected to another xMatrix Space. ` +
        "To move it here, a Slack workspace admin removes the xMatrix app from the workspace first, then connect again." }
      : { tone: "warning", message: providerId === "x"
        ? "X authorization did not finish. Use Add X account to try again."
        : `${name} did not finish connecting. Try again, or paste a token under Credentials.` });
    url.searchParams.delete("oauth");
    // Through the app's own address writer, so the router learns the new address: this
    // view opens after the shell, whose router would otherwise put the old one back.
    replaceBrowserPath(`${url.pathname}${url.search}${url.hash}`);
    // The connector remains the single selected detail while return flags are consumed.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on return from the provider
  }, []);

  useEffect(() => {
    const status = takeGitHubConnectOutcome();
    if (!status) return;
    if (status === "connected") {
      setSetupNotice({
        tone: "success",
        message: "GitHub is connected. Open Configure to set channel routing, or manage repository access on GitHub.",
      });
    } else if (status === "updated") {
      setSetupNotice({
        tone: "success",
        message: "GitHub access was updated. Repository selection and App permissions now match GitHub.",
      });
    } else if (status === "pending") {
      setSetupNotice({
        tone: "warning",
        message: "GitHub installation approval is pending. An organization owner must approve the request before this space can connect.",
      });
    } else if (status === "cancelled") {
      setSetupNotice({ tone: "warning", message: "GitHub connection was cancelled before installation completed." });
    } else if (status === "authorized") {
      setSetupNotice({
        tone: "success",
        message: "GitHub confirmed your accounts. Choose which ones this Space reaches under GitHub accounts.",
      });
    } else {
      setSetupNotice({
        tone: "warning",
        message: "GitHub did not finish connecting to this space. Try Connect GitHub again.",
      });
    }
  }, []);

  const loadExecutions = useCallback(async () => {
    setExecutionsError(null);
    await executionsQuery.refetch();
  }, [executionsQuery]);

  async function configureConnector(
    connector: AppConnectorManifest,
    options?: { mode?: "add" | "manage" | "install" | "account"; installationId?: string; xAccountId?: string }
  ) {
    if (!token || !currentSpace) return;
    const existingConnection = connectionsByProvider.get(connector.id);
    setUpdatingProviderId(connector.id);
    setConnectionsError(null);
    try {
      if (connector.id === "github") {
        const retainedInstallationIds = githubConnectionInstallationIdsFromMetadata(existingConnection?.metadata);
        const installationId = options?.installationId?.trim()
          || retainedInstallationIds[0]
          || "";
        // Only a connection in error recovers by a check; after Disconnect,
        // Connect authorizes on GitHub again.
        if (existingConnection?.status === "error" && installationId && options?.mode !== "add") {
          const checkPayload = await connectionMutation.mutateAsync({
            url: WEB_PROXY_ROUTES.space_app_connection_check(currentSpace.id, connector.id),
            method: "POST",
          }).catch(() => ({ connection: undefined }));
          if (checkPayload.connection?.status === "configured") {
            setConnections((current) => [
              ...current.filter((connection) => connection.providerId !== connector.id),
              checkPayload.connection!,
            ]);
            setSelectedConnectorId(connector.id);
            return;
          }
        }
        const mode = options?.mode
          || (existingConnection?.status === "configured"
            ? "manage"
            : installationId
              ? "install"
              : "install");
        const payload = await connectionMutation.mutateAsync({
          url: WEB_PROXY_ROUTES.github_app_install(currentSpace.id, {
            mode: mode === "install" ? undefined : mode,
            installationId: mode === "manage" ? installationId || undefined : undefined,
          }),
        });
        if (!payload.url) throw unexpectedResponse("The GitHub install link");
        window.location.assign(payload.url);
        return;
      }

      if (["googlechat", "feishu", "telegram", "teams"].includes(connector.id) && nativeProviders.includes(connector.id)) {
        await ensureConnectionRow(connector);
        document.getElementById(connector.id === "teams" ? "teams-link-start" : `${connector.id}-room-input`)?.focus();
        return;
      }
      if (connector.id === "wecom" && nativeProviders.includes("wecom")) {
        await ensureConnectionRow(connector);
        document.getElementById("wecom-install-start")?.focus();
        return;
      }

      if (oauthProviders.includes(connector.id)) {
        const started = await connectionMutation.mutateAsync({
          url: WEB_PROXY_ROUTES.space_app_connection_oauth_start(currentSpace.id, connector.id),
          method: "POST",
          body: connector.id === "x" && options?.xAccountId ? { accountId: options.xAccountId } : undefined,
        });
        if (!started.url) throw unexpectedResponse("The sign-in link");
        window.location.assign(started.url);
        return;
      }

      await connectWithCredentials(connector);
    } catch (error) {
      setConnectionsError(userErrorMessage(error, "Couldn't connect the app", `Couldn't connect ${connector.name}`));
    } finally {
      setUpdatingProviderId(null);
    }
  }

  /* A token app is Connected only once the Hub has tried its credentials
     (Check): the row they are stored on comes first, unconnected. */
  async function ensureConnectionRow(connector: AppConnectorManifest) {
    if (!token || !currentSpace || connectionsByProvider.has(connector.id)) return;
    const payload = await connectionMutation.mutateAsync({
      url: WEB_PROXY_ROUTES.space_app_connection(currentSpace.id, connector.id),
      method: "PATCH",
      body: { providerId: connector.id, providerName: connector.name, status: "disconnected" },
    });
    if (payload.connection) setConnections((current) => [...current, payload.connection!]);
  }

  /* Apps with nothing to type: generate what the Hub mints (an ingress URL),
     then check. Apps with typed credentials connect from their Credentials form. */
  async function connectWithCredentials(connector: AppConnectorManifest) {
    if (!token || !currentSpace) return;
    await ensureConnectionRow(connector);
    if (connectorGeneratesCredentials(connector)) {
      await xmatrixApiRequest({
        url: WEB_PROXY_ROUTES.space_app_connection_credentials(currentSpace.id, connector.id),
        method: "PUT", token, body: {},
      });
    }
    await checkConnector(connector);
  }

  async function patchConnectorConnection(providerId: string, body: Record<string, unknown>) {
    const payload = await connectionMutation.mutateAsync({
      url: WEB_PROXY_ROUTES.space_app_connection(currentSpace!.id, providerId), method: "PATCH", body,
    });
    if (!payload.connection) throw unexpectedResponse("The connection");
    setConnections(current => [...current.filter(connection => connection.providerId !== providerId), payload.connection!]);
  }

  async function disconnectConnector(connector: AppConnectorManifest) {
    if (!token || !currentSpace) return;
    setUpdatingProviderId(connector.id);
    setDisconnectingProviderId(connector.id);
    setConnectionsError(null);
    try {
      await patchConnectorConnection(connector.id, { providerId: connector.id, status: "disconnected" });
    } catch (error) {
      setConnectionsError(userErrorMessage(error, "Couldn't disconnect the app", `Couldn't disconnect ${connector.name}`));
    } finally {
      setUpdatingProviderId(null);
      setDisconnectingProviderId(null);
    }
  }

  async function checkConnector(connector: AppConnectorManifest) {
    if (!token || !currentSpace) return;
    setCheckingProviderId(connector.id);
    setConnectionsError(null);
    try {
      const payload = await connectionMutation.mutateAsync({
        url: WEB_PROXY_ROUTES.space_app_connection_check(currentSpace.id, connector.id),
        method: "POST",
      });
      if (!payload.connection) throw unexpectedResponse("The connection");
      setConnections((current) => [
        ...current.filter((connection) => connection.providerId !== connector.id),
        payload.connection!,
      ]);
      setSelectedConnectorId(connector.id);
      if (payload.connection.status === "error") {
        setConnectionsError(payload.connection.error || payload.message || "App connection check failed");
      }
    } catch (error) {
      setConnectionsError(userErrorMessage(error, "Couldn't check the app", `Couldn't check ${connector.name}`));
    } finally {
      setCheckingProviderId(null);
    }
  }

  async function saveConnectorMetadata(connector: AppConnectorManifest, metadata: Record<string, unknown>) {
    await patchConnectorConnection(connector.id, { providerId: connector.id, metadata });
  }

  function connectorRow(connector: AppConnectorManifest) {
    const Icon = connectorIcon(connector);
    const connection = connectionsByProvider.get(connector.id);
    const needsAttention = connection?.status === "error";
    const connected = connection?.status === "configured";
    // The group says the state; a row ends in the state's mark: a green tick
    // when it works, a warning when it stopped (with what stopped under it).
    const StateIcon = needsAttention ? AlertTriangle : connected ? Check : null;
    const stateLabel = needsAttention ? "Needs attention" : "Connected";
    return (
      <ToolListRow key={connector.id} testId="connector-row"
        selected={Boolean(connectorId) && connector.id === selectedConnector?.id}
        shownBeside={!connectorId && connector.id === selectedConnector?.id}
        onSelect={() => selectConnector(connector.id)}
        leading={<Icon className="size-7" />}
        title={connector.name}
        trailing={StateIcon ? <span role="img" aria-label={stateLabel} title={stateLabel}
          className="app-tool-state-icon flex shrink-0" data-state={needsAttention ? "attention" : "connected"}>
          <StateIcon className="size-4" strokeWidth={2.5} /></span> : null}
        state={needsAttention ? "attention" : connected ? "running" : "paused"}
        subtitle={needsAttention ? connection?.error || "The connection needs to be authorized again" : undefined} />
    );
  }

  const list = (
    <ToolList title="Apps">
      <div className="app-connectors-list">
        {groupConnectorsForList(connectors, connections).map((group) => (
          <ToolListGroup key={group.title} title={group.title}>
            {group.categories
              ? group.categories.flatMap((category) => [
                  <li key={`category:${category.title}`} role="presentation"
                    className="app-tool-list-subheading pt-2 pb-0.5 pl-[var(--app-list-row-start)] pr-[var(--app-list-row-end)] text-xs font-medium text-muted-foreground">
                    {category.title}
                  </li>,
                  ...category.connectors.map(connectorRow),
                ])
              : group.connectors.map(connectorRow)}
          </ToolListGroup>
        ))}
      </div>
    </ToolList>
  );

  const connector = selectedConnector;
  const detail = connector && token && currentSpace && user?.id ? (
    <ConnectorDetailPage key={connector.id} connector={connector} Icon={connectorIcon(connector)}
      connection={selectedConnection} spaceId={currentSpace.id} token={token} userId={user.id}
      members={currentSpace.members}
      oauth={oauthProviders.includes(connector.id)} native={nativeProviders.includes(connector.id)}
      executions={selectedExecutions} executionsLoading={loadingExecutions} executionsError={executionsError}
      notice={setupNotice} error={connectionsError}
      connecting={updatingProviderId === connector.id} checking={checkingProviderId === connector.id}
      disconnecting={disconnectingProviderId === connector.id}
      onBack={() => selectConnector(null)}
      onConnect={(options) => void configureConnector(connector, options)}
      onCheck={() => checkConnector(connector)}
      onDisconnect={() => void disconnectConnector(connector)}
      onRefreshExecutions={() => void loadExecutions()}
      onSaveMetadata={(metadata) => saveConnectorMetadata(connector, metadata)}
      ensureConnectionRow={() => ensureConnectionRow(connector)}
      refreshConnections={async () => { await connectionsQuery.refetch(); }} />
  ) : null;

  return (
    <div className="app-connectors-view flex min-h-0 min-w-0 flex-1">
      <ToolSplit label="Apps" open={Boolean(connectorId)} list={list} detail={detail} />
    </div>
  );
}

export function githubConnectionInstallationIdsFromMetadata(
  metadata: Record<string, unknown> | undefined
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const id = value.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  if (Array.isArray(metadata?.installationIds)) {
    for (const item of metadata.installationIds) push(item);
  }
  push(metadata?.installationId);
  return ids;
}

export function ActivityView({ events }: { events: ObservabilityEvent[] }) {
  if (events.length === 0) {
    return (
      <ToolDetailEmpty icon={<Radio />} title="No activity yet">
        <p>Events will appear once agents start communicating.</p>
      </ToolDetailEmpty>
    );
  }
  return (
    <ToolDetail title="Activity" status="Relay events from agents and channels in this Space.">
      <ul className="app-tool-lines">
        {events.map((event) => {
          const Icon = EVENT_ICONS[event.type] || Radio;
          return (
            <li key={event.id} className="flex items-start gap-3 py-2.5">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {/* Wrap rather than truncate: on a phone the agent name alone
                  is wider than the line, and shrinking both left the event
                  label as "agent c...". */}
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold">{eventLabel(event)}</span>
                {event.agentName && (
                  <span className="min-w-0 max-w-full truncate text-xs text-muted-foreground">{event.agentName}</span>
                )}
              </div>
              <span className="shrink-0 text-xs leading-5 tabular-nums text-muted-foreground">
                {formatTime(event.timestamp)}
              </span>
            </li>
          );
        })}
      </ul>
    </ToolDetail>
  );
}

import {
  desktopDaemonLabel,
} from "./workspace-shell-desktop-labels";
export {
  daemonStatusNeedsSessionSync,
  desktopDaemonLabel,
  desktopUpdateDescription,
  desktopUpdateErrorStatus,
  desktopUpdateLabel,
} from "./workspace-shell-desktop-labels";

function MachineVersionFacts({ machine }: { machine: MachineSummary }) {
  return <>
    <ToolFact label="Daemon version"><MachineVersionValue version={machine.daemonVersion} component="cli" /></ToolFact>
    <ToolFact label="CLI version"><MachineVersionValue version={machine.cliVersion} component="cli" /></ToolFact>
    <ToolFact label="App version"><MachineVersionValue version={machine.appVersion} component="desktop" /></ToolFact>
    <ToolFact label="Last seen">{machine.lastSeenAt ? relativeTime(machine.lastSeenAt) : "-"}</ToolFact>
  </>;
}
