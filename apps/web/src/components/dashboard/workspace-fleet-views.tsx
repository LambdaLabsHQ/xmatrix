"use client";

import { APP_CONNECTOR_PROVIDER_MANIFESTS, agentAvatarUrlFromMetadata, agentLaunchExecutable } from "@xmatrix/protocol";
import Image from "next/image";
import { registrationStatus } from "./my-agents-registrations";
import {
  DetailRow,
  EmptyToolState,
  ErrorPanel,
  MachineVersionValue,
  removeMachine,
  renameMachine,
  setMachineAutoAssign,
} from "./workspace-admin-views";

import { GoogleChatRoomLink } from "./googlechat-room-link";
import { WeComCompanyConnection } from "./wecom-company-connection";
import { DingTalkCompanyConnection } from "./dingtalk-company-connection";
import type { HumanProfile } from "@xmatrix/protocol";

import {
  COUNT_CHIP_MATERIAL_CLASS,
  EVENT_ICONS,
} from "./workspace-shell-constants";

import {
  localManagedAgentAvatarUrl,
} from "./workspace-shell-formatters";

import {
  LocalManagedAgent,
  MachineSummary,
} from "./workspace-shell-helpers";

import {
} from "./workspace-shell-helpers-extra";

import {
  AppView,
} from "./workspace-shell-navigation";

import {
  avatarInitials,
  eventLabel,
  formatTime,
  relativeTime,
} from "./workspace-shell-recovered";

import { daemonPresenceLabel } from "./machine-daemon-presence";
import { MachineLoadGlance, MachineLoadPanel } from "./machine-load-panel";
import { MachineHarnessPanel } from "./machine-harness-panel";
import { MachineGlyph } from "./machine-glyph";
import { machineOs } from "./machine-os";
import {
  ToolDetail, ToolDetailEmpty, ToolDetailSection, ToolFact, ToolFacts, ToolList, ToolListRow, ToolSplit,
  ToolStateDot, useToolItem,
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
  Bug,
  Check,
  ChevronDown,
  Circle,
  Clock,
  Download,
  Folder,
  FolderOpen,
  GitPullRequest,
  HardDrive,
  Loader2,
  ListTodo,
  LogOut,
  MessageSquare,
  MessageSquareText,
  Pencil,
  PlugZap,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  Settings,
  Shield,
  Siren,
  Terminal,
  Cpu,
  Trash2,
  PowerOff,
  Unplug,
  Users,
  Webhook,
  Wrench,
} from "lucide-react";

import { ListSkeleton } from "./content-skeleton";
import { Textarea } from "@/components/ui/textarea";

import { Input } from "@/components/ui/input";

import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
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

import { type AppConnectorManifest } from "@/lib/app-connectors";
import { ConnectorCredentials, connectorGeneratesCredentials, connectorTakesCredentials, connectorWritableCredentials } from "./connector-credentials";
import { ConnectorPolicy, connectorWriteActions } from "./connector-policy";

import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { GoogleDocFileSelection } from "./google-doc-file-selection";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

import { cn } from "@/lib/utils";
import { noticeClass, statusChipClass } from "@/components/ui/status-tone";

import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import type {
  ObservabilityEvent,
  SerializedAppConnectorConnection,
  SerializedAppConnectorExecution,
  SerializedChannel,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";

// Semantic module extracted from workspace-app-shell (AST-safe)

export function connectorConnectionStatusLabel(status: SerializedAppConnectorConnection["status"]): string {
  if (status === "configured") return "Connected";
  if (status === "error") return "Needs attention";
  return "Disconnected";
}

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
            <IdentityAvatar kind="human" label={profile.displayName} imageUrl={profile.avatarUrl}
              initials={profile.displayName.slice(0, 2)} size="xs" showKindBadge={false}
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
        viewItem("agents", "Agents", "Registered agents and where they run", Cpu),
        viewItem("machines", "Machines", "Registered machines and daemons", Terminal),
        viewItem("automation", "Schedules", "Scheduled channel activity", Clock),
      ],
    },
  );

  /* The desktop rail's Help menu carries this; on a phone it lives here. */
  if (onReportIssue) {
    groups.push({
      label: "Support",
      items: [
        {
          key: "report-issue",
          label: "Report an issue",
          description: "Tell us what is broken or missing on GitHub",
          icon: MessageSquareText,
          onSelect: onReportIssue,
        },
      ],
    });
  }

  if (platformAdmin) {
    groups.push({
      label: "Platform",
      items: [
        viewItem("admin", "Platform admin", "Platform-wide usage, invites, and product prompts", Shield),
      ],
    });
  }

  /* Settings' list on its paper: section headings over plain list rows, no
     cards, boards or glass. You are the first row, as Slack's "You" is. */
  return (
    <div className="app-tool-detail-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl md:pt-6">
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
                {importing ? <Loader2 className="animate-spin" /> : <Plus />} Add
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
              {busy === "setup:complete" ? <Loader2 className="animate-spin" /> : <Check />}
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
                {busy === "machine:name" ? <Loader2 className="animate-spin" /> : null} Save name
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
            {daemonStarting ? <Loader2 className="animate-spin" /> : <Radio />}
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
                    <IdentityAvatar kind="agent" label={agent.name} imageUrl={localManagedAgentAvatarUrl(agent)}
                      initials={avatarInitials(agent.name)} size="sm" showKindBadge={false} />
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
            {busy === "workspace:add" ? <Loader2 className="animate-spin" /> : <Plus />} Add directory
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
                        {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
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
            <RefreshCw className={cn(loadingDiscoveries && "animate-spin")} />
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
                        <IdentityAvatar kind="agent" label={discovery.displayName}
                          imageUrl={agentAvatarUrlFromMetadata({ presetId: discovery.presetId }, discovery.presetId)}
                          initials={avatarInitials(discovery.displayName)} size="sm" showKindBadge={false} />
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
                          {importing ? <Loader2 className="animate-spin" /> : <Plus />} Add agent
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

/** A WSL Machine is listed right after its Windows host. */
function machinesWithHostsFirst(machines: MachineSummary[]): MachineSummary[] {
  const hosts = new Set(machines.map((machine) => machine.machineId).filter(Boolean));
  const hosted = (machine: MachineSummary) => Boolean(machine.parentMachineId && hosts.has(machine.parentMachineId));
  return machines.filter((machine) => !hosted(machine)).flatMap((machine) => [machine,
    ...machines.filter((child) => hosted(child) && child.parentMachineId === machine.machineId)]);
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
  defaultItem,
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
  /** The item shown when the address names none (this machine, opened from setup). */
  defaultItem?: string;
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
  const [item, select] = useToolItem();
  // Load samples expire after 90 seconds; re-judge freshness between refreshes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const nameOf = (machine: MachineSummary) => (machine.machineId && renamed[machine.machineId]) || machine.name;
  const hostOf = (machine: MachineSummary) => machines.find((host) =>
    host.machineId && host.machineId === machine.parentMachineId);
  // The daemon reports its OS in metadata; a Machine without one shows the generic mark.
  const platformOf = (machine: MachineSummary) => {
    const platform = machine.daemon?.metadata?.platform;
    return typeof platform === "string" ? platform : undefined;
  };
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
      setRenameError(reason instanceof Error ? reason.message : "The Machine could not be renamed");
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
      setAssignError(reason instanceof Error ? reason.message : "Automatic assignment could not be changed");
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
      setRemoveError(reason instanceof Error ? reason.message : "The Machine could not be removed");
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
  const chosenKey = item ?? defaultItem ?? null;
  const showingThis = Boolean(thisMachine) && (chosenKey === THIS_MACHINE_ITEM
    || Boolean(thisRecord && chosenKey === thisRecord.id));
  const chosen = showingThis ? null : listed.find((machine) => machine.id === chosenKey);
  const shown = showingThis ? null : chosen ?? (thisMachine ? null : listed[0]);
  const showThisBeside = Boolean(thisMachine) && !showingThis && !chosen;
  // This machine is said, not boxed: in ink at the head of its quiet line, where every other Machine says less.
  // Called what its OS calls it: This Mac, This PC; any other OS is "This Machine", capitalised alike.
  const thisOs = thisMachine ? machineOs(thisMachine.platform) : "unknown";
  const thisLabel = thisOs === "macos" ? "This Mac" : thisOs === "windows" ? "This PC" : "This Machine";
  const thisTag = <span className="font-semibold text-foreground" data-testid="this-machine-tag">{thisLabel}</span>;
  // What a Machine is doing now: Agents running on it while online, when it was last seen once offline.
  const stateOf = (machine: MachineSummary) => machine.status === "online"
    ? machine.activeRuns === undefined ? null
      : machine.activeRuns === 0 ? "Idle" : `${machine.activeRuns} ${machine.activeRuns === 1 ? "agent" : "agents"} running`
    : machine.lastSeenAt ? `Offline · seen ${relativeTime(machine.lastSeenAt)}` : "Offline";

  const list = (
    <ToolList title="Machines">
      {error && <p role="alert" className="px-5 pb-2 text-xs font-medium text-destructive md:px-6">{error}</p>}
      {identityUnavailable && <p role="status" className="px-5 pb-2 text-xs text-muted-foreground md:px-6">
        Update xMatrix to identify this computer and show its controls on the registered Machine.
      </p>}
      <ul>
        {loading && ordered.length === 0 ? (
          <li className="list-none px-5 md:px-6"><ListSkeleton label="Loading machines" rows={4} /></li>
        ) : ordered.length === 0 ? (
          <li className="px-5 py-2 text-sm text-muted-foreground md:px-6">No machines registered.</li>
        ) : ordered.map((machine) => {
          // This machine is a row like any other, only tagged; before the Hub lists it, the desktop says its state.
          const local = !machine || isThis(machine);
          const name = machine ? nameOf(machine) : thisMachine!.name;
          const host = machine ? hostOf(machine) : undefined;
          const online = machine ? machine.status === "online" : thisMachine!.online;
          const facts = [host ? `WSL on ${nameOf(host)}` : null,
            machine ? stateOf(machine) : thisMachine!.summary,
            machine && !autoAssigned(machine) ? "Named only" : null].filter(Boolean).join(" · ");
          return (
            <ToolListRow key={machine?.id ?? THIS_MACHINE_ITEM} testId="machine-row"
              selected={local ? showingThis : machine!.id === chosen?.id}
              shownBeside={local ? showThisBeside && !item
                : !chosen && !showingThis && !showThisBeside && machine!.id === shown?.id}
              onSelect={() => select(local ? THIS_MACHINE_ITEM : machine!.id)}
              leading={<span className={cn("app-tool-state-icon", host && "pl-4")} data-state={online ? "running" : "offline"}
                aria-label={`${name}: ${online ? "online" : "offline"}`} role="img">
                <MachineGlyph os={machineOs(local ? thisMachine!.platform : platformOf(machine!))} /></span>}
              trailing={machine && <MachineLoadGlance machine={machine} now={now} />}
              title={name}
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
    const titleControl = "flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50";
    detail = (
      <ToolDetail
        key={machine?.id ?? THIS_MACHINE_ITEM}
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
              {renameBusy ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
            </button>
            <button type="button" className={cn(titleControl, "hover:text-destructive")}
              title={`Remove ${name}`}
              aria-label={`Remove ${name}`}
              disabled={Boolean(removingId)}
              onClick={() => void remove(machine)}>
              {removingId === machine.machineId ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </button>
          </>
        ) : undefined}
        status={
          <span className="flex flex-wrap items-center gap-x-2">
            <ToolStateDot state={online ? "running" : "offline"} />
            <span className="capitalize text-foreground">{online ? "online" : "offline"}</span>
            <span>· {local ? thisTag : null}{local && host ? " · " : null}{host ? `WSL on ${nameOf(host)}` : local ? null : "machine"}</span>
            {machine?.lastSeenAt && <span>· seen {relativeTime(machine.lastSeenAt)}</span>}
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
          load: <MachineLoadPanel machine={machine} now={now} />,
        } : null) : machine && (
          <>
            <ToolDetailSection title="Daemon">
              <ToolFacts>
                <ToolFact label="Daemon">{daemonPresenceLabel(machine.daemon)}</ToolFact>
                <MachineVersionFacts machine={machine} />
              </ToolFacts>
              <MachineLoadPanel machine={machine} now={now} />
            </ToolDetailSection>
            <ToolDetailSection title="Harnesses">
              <MachineHarnessPanel key={machine.id} daemon={machine.daemon} token={token} spaceId={spaceId} />
            </ToolDetailSection>
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

  return <ToolSplit label="Machines" open={Boolean(item)} list={list} detail={detail} />;
}

/** The address key of the desktop app's own machine in the Machines list. */
export const THIS_MACHINE_ITEM = "this-machine";

export interface AppConnectorConfigurationDraft {
  repository: string;
  actionsWorkflowIds: string;
}

const NO_CONNECTIONS: SerializedAppConnectorConnection[] = [];
const NO_EXECUTIONS: SerializedAppConnectorExecution[] = [];

export function AppsView({
  connectors,
  currentSpace,
  token,
  channels,
}: {
  connectors: AppConnectorManifest[];
  currentSpace: SerializedSpace | null;
  token?: string;
  channels: SerializedChannel[];
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // The connector open beside the list is named in the address, like every rail destination's item.
  const [connectorItem, selectConnector] = useToolItem();
  const selectedConnectorId = connectorItem ?? connectors[0]?.id ?? "";
  const setSelectedConnectorId = (id: string) => selectConnector(id, { replace: true });
  const [connectionActionError, setConnectionsError] = useState<string | null>(null);
  const [setupNotice, setSetupNotice] = useState<{ tone: "success" | "warning"; message: string } | null>(null);
  const [executionActionError, setExecutionsError] = useState<string | null>(null);
  const [updatingProviderId, setUpdatingProviderId] = useState<string | null>(null);
  const [disconnectingProviderId, setDisconnectingProviderId] = useState<string | null>(null);
  const [checkingProviderId, setCheckingProviderId] = useState<string | null>(null);
  const [configuringProviderId, setConfiguringProviderId] = useState<string | null>(null);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [configurationDraft, setConfigurationDraft] = useState<AppConnectorConfigurationDraft | null>(null);
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
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "connector-oauth-providers", []),
    queryFn: ({ signal }) => xmatrixApiRequest<{ providers?: string[]; nativeProviders?: string[] }>({
      url: WEB_PROXY_ROUTES.connector_oauth_providers, token, signal,
    }).then((payload) => ({ providers: payload.providers ?? [], nativeProviders: payload.nativeProviders ?? [] })),
    enabled: Boolean(token && user?.id),
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
  const executions = executionsQuery.data ?? NO_EXECUTIONS;
  const connectionsError = connectionActionError ?? connectionsQuery.error?.message ?? null;
  const executionsError = executionActionError ?? executionsQuery.error?.message ?? null;
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
    setConfiguringProviderId(null);
    setConfigurationDraft(null);
  }, [currentSpace?.id]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("oauth");
    const providerId = url.searchParams.get("connector");
    if (!outcome || !providerId) return;
    const name = connectors.find((connector) => connector.id === providerId)?.name ?? providerId;
    setSetupNotice(outcome === "connected"
      ? { tone: "success", message: `${name} is connected. Subscribe a channel or allow its actions below.` }
      : { tone: "warning", message: `${name} did not finish connecting. Try again, or paste a token under Credentials.` });
    url.searchParams.delete("oauth");
    url.searchParams.delete("connector");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    // Selecting writes ?item= to the address; consume callback params first so cleanup keeps that selection.
    setSelectedConnectorId(providerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on return from the provider
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get("github");
    if (!status) return;
    url.searchParams.delete("github");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (status === "connected") {
      setSetupNotice({
        tone: "success",
        message: "GitHub is connected. Open Configure to set channel routing, or manage repository access on GitHub.",
      });
      setSelectedConnectorId("github");
    } else if (status === "updated") {
      setSetupNotice({
        tone: "success",
        message: "GitHub access was updated. Repository selection and App permissions now match GitHub.",
      });
      setSelectedConnectorId("github");
    } else if (status === "pending") {
      setSetupNotice({
        tone: "warning",
        message: "GitHub installation approval is pending. An organization owner must approve the request before this space can connect.",
      });
    } else if (status === "cancelled") {
      setSetupNotice({ tone: "warning", message: "GitHub connection was cancelled before installation completed." });
    } else if (status === "account_required") {
      setSetupNotice({
        tone: "warning",
        message: "Link the GitHub account that installed the app in your profile, then Connect GitHub again.",
      });
    } else {
      setSetupNotice({
        tone: "warning",
        message: "GitHub did not finish connecting to this space. Try Connect GitHub again.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on return from GitHub
  }, []);

  const loadExecutions = useCallback(async () => {
    setExecutionsError(null);
    await executionsQuery.refetch();
  }, [executionsQuery]);

  async function configureConnector(
    connector: AppConnectorManifest,
    options?: { mode?: "add" | "manage" | "install"; installationId?: string }
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
        if (!payload.url) throw new Error("Failed to start GitHub install");
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
        });
        if (!started.url) throw new Error(`Failed to start connecting ${connector.name}`);
        window.location.assign(started.url);
        return;
      }

      await connectWithCredentials(connector);
    } catch (error) {
      setConnectionsError((error as Error).message);
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

  async function patchConnectorConnection(providerId: string, body: Record<string, unknown>, fallback: string) {
    const payload = await connectionMutation.mutateAsync({
      url: WEB_PROXY_ROUTES.space_app_connection(currentSpace!.id, providerId), method: "PATCH", body,
    });
    if (!payload.connection) throw new Error(fallback);
    setConnections(current => [...current.filter(connection => connection.providerId !== providerId), payload.connection!]);
  }

  async function disconnectConnector(connector: AppConnectorManifest) {
    if (!token || !currentSpace) return;
    setUpdatingProviderId(connector.id);
    setDisconnectingProviderId(connector.id);
    setConnectionsError(null);
    try {
      await patchConnectorConnection(connector.id, { providerId: connector.id, status: "disconnected" },
        "Failed to disconnect app connection");
      if (configuringProviderId === connector.id) closeConnectorConfiguration();
    } catch (error) {
      setConnectionsError((error as Error).message);
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
      if (!payload.connection) throw new Error("Failed to check app connection");
      setConnections((current) => [
        ...current.filter((connection) => connection.providerId !== connector.id),
        payload.connection!,
      ]);
      setSelectedConnectorId(connector.id);
      if (payload.connection.status === "error") {
        setConnectionsError(payload.connection.error || payload.message || "App connection check failed");
      }
    } catch (error) {
      setConnectionsError((error as Error).message);
    } finally {
      setCheckingProviderId(null);
    }
  }

  function openConnectorConfiguration(
    connector: AppConnectorManifest,
    connection: SerializedAppConnectorConnection
  ) {
    const metadata = connection.metadata || {};
    const metadataText = (key: string) => typeof metadata[key] === "string" ? metadata[key] : "";
    const metadataListText = (key: string) => Array.isArray(metadata[key])
      ? metadata[key].filter((value): value is string => typeof value === "string").join("\n")
      : "";
    setConnectionsError(null);
    setSelectedConnectorId(connector.id);
    setConfiguringProviderId(connector.id);
    setConfigurationDraft({
      repository: metadataText("repository") || metadataText("githubRepository"),
      actionsWorkflowIds: metadataListText("actionsWorkflowIds"),
    });
  }

  function closeConnectorConfiguration() {
    setConfiguringProviderId(null);
    setConfigurationDraft(null);
    setConnectionsError(null);
  }

  async function saveConnectorConfiguration(
    connector: AppConnectorManifest,
    connection: SerializedAppConnectorConnection
  ) {
    if (!token || !currentSpace || !configurationDraft) return;
    const actionsWorkflowIds = Array.from(new Set(configurationDraft.actionsWorkflowIds
      .split(/[\r\n,]+/u)
      .map((value) => value.trim())
      .filter(Boolean)));
    if (actionsWorkflowIds.length > 32 || actionsWorkflowIds.some((value) =>
      value.length > 128 || !/^(?:[1-9][0-9]*|[A-Za-z0-9_.-]+\.ya?ml)$/u.test(value)
    )) {
      setConnectionsError("Allowed workflow dispatches must contain at most 32 numeric ids or .yml/.yaml file names.");
      return;
    }
    setSavingProviderId(connector.id);
    setConnectionsError(null);
    try {
      await patchConnectorConnection(connector.id, {
        providerId: connector.id,
        metadata: { ...connection.metadata, repository: configurationDraft.repository, actionsWorkflowIds },
      }, "Failed to save connector configuration");
      closeConnectorConfiguration();
    } catch (error) {
      setConnectionsError((error as Error).message);
    } finally {
      setSavingProviderId(null);
    }
  }

  const connectorState = (connector: AppConnectorManifest) => {
    const connection = connectionsByProvider.get(connector.id);
    const available = connector.status === "available";
    const configured = connection?.status === "configured";
    const needsAttention = connection?.status === "error";
    return {
      connection, available, configured, needsAttention,
      label: configured ? "Connected" : needsAttention ? "Needs attention" : connection ? "Disconnected"
        : available ? "Not connected" : "Coming soon",
      summary: configured ? "Ready in every channel in this space"
        : needsAttention ? connection.error || "The connection needs to be authorized again"
          : connection ? "Reconnect to resume channel delivery"
            : available ? "Connect an account and choose what xMatrix can access" : "This connector is not available yet",
    };
  };

  const list = (
    <ToolList title="Apps">
      <ul className="app-connectors-list">
        {connectors.map((connector) => {
          const Icon = connectorIcon(connector);
          const state = connectorState(connector);
          // Not connected yet says nothing: the line under the name already invites a connection.
          const StateIcon = state.configured ? Check : state.needsAttention ? AlertTriangle : state.connection ? Unplug : null;
          return (
            <ToolListRow key={connector.id} testId="connector-row"
              selected={Boolean(connectorItem) && connector.id === selectedConnector?.id}
              shownBeside={!connectorItem && connector.id === selectedConnector?.id}
              onSelect={() => { selectConnector(connector.id); closeConnectorConfiguration(); }}
              leading={<Icon className="size-7" />}
              title={connector.name}
              trailing={StateIcon && <span role="img" aria-label={state.label} title={state.label}
                className="app-tool-state-icon app-connector-state-icon flex shrink-0" data-state={state.needsAttention ? "attention" : state.configured ? "running" : "offline"}>
                <StateIcon className="size-4" /></span>}
              state={state.needsAttention ? "attention" : state.configured ? "running" : "paused"}
              subtitle={state.summary} />
          );
        })}
      </ul>
    </ToolList>
  );

  const connector = selectedConnector;
  const DetailIcon = connector ? connectorIcon(connector) : PlugZap;
  const state = connector ? connectorState(connector) : null;
  const updating = connector ? updatingProviderId === connector.id : false;
  const checking = connector ? checkingProviderId === connector.id : false;
  const configuring = Boolean(connector && configuringProviderId === connector.id);
  const detail = connector && state ? (
    <ToolDetail
      key={connector.id}
      onBack={() => selectConnector(null)}
      backLabel="Apps"
      context={`Apps · ${currentSpace?.name || "this space"}`}
      title={<span className="inline-flex items-center gap-3"><DetailIcon className="size-7" />{connector.name}</span>}
      status={
        <span className="flex flex-wrap items-center gap-x-2">
          <ToolStateDot state={state.needsAttention ? "attention" : state.configured ? "running" : "offline"} />
          <span className={cn("text-foreground", state.needsAttention && "text-destructive")}>{state.label}</span>
          <span>· {state.summary}</span>
          {state.configured && state.connection?.lastCheckedAt ? <span>· checked {relativeTime(state.connection.lastCheckedAt)}</span> : null}
        </span>
      }
      actions={
        <div className="app-connector-actions flex flex-wrap items-center gap-2" role="group"
          aria-label={`${connector.name} connection actions`}>
          {state.configured && state.connection ? (
            <>
              <Button size="sm" variant="outline" disabled={updating || checking || savingProviderId === connector.id || configuring}
                onClick={() => openConnectorConfiguration(connector, state.connection!)}>
                <Settings /> Configure
              </Button>
              {oauthProviders.includes(connector.id) || nativeProviders.includes(connector.id) ? (
                <Button size="sm" variant="outline" disabled={updating || checking || savingProviderId === connector.id || configuring}
                  onClick={() => void configureConnector(connector)}
                  title={`Reconnect ${connector.name}`} aria-label={`Reconnect ${connector.name}`}>
                  {updating ? <Loader2 className="animate-spin" /> : <PlugZap />} Reconnect
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" disabled={updating || checking}
                onClick={() => void disconnectConnector(connector)}
                className="text-muted-foreground hover:text-destructive"
                title={`Disconnect ${connector.name}`} aria-label={`Disconnect ${connector.name}`}>
                <LogOut /> {disconnectingProviderId === connector.id ? "Disconnecting" : "Disconnect"}
              </Button>
            </>
          ) : state.available && (connector.id === "github" || oauthProviders.includes(connector.id) || nativeProviders.includes(connector.id)
            || connectorWritableCredentials(connector).length === 0) ? (
            <Button size="sm" variant="outline" disabled={updating || checking} onClick={() => void configureConnector(connector)}>
              {updating ? <Loader2 className="animate-spin" /> : <PlugZap />}
              {state.connection ? "Reconnect" : connector.id === "github" ? "Connect GitHub"
                : oauthProviders.includes(connector.id) ? `Connect with ${connector.name}` : "Connect"}
            </Button>
          ) : null}
          {(state.configured || state.needsAttention) && state.connection ? (
            <Button size="sm" variant="outline" disabled={updating || checking || savingProviderId === connector.id}
              onClick={() => void checkConnector(connector)}
              title={`Check ${connector.name} connection`} aria-label={`Check ${connector.name} connection`}>
              {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check
            </Button>
          ) : null}
        </div>
      }
    >
      {setupNotice ? (
        <p className={noticeClass(setupNotice.tone === "success" ? "settled" : "attention", "rounded-lg p-3 font-medium")}>
          {setupNotice.message}
        </p>
      ) : null}
      {connectionsError && <p className="text-sm font-medium text-destructive">{connectionsError}</p>}
      <p className="text-sm leading-6 text-muted-foreground">{connector.description}</p>
      {connector.id === "google" && state.configured && token && currentSpace ? (
        <ToolDetailSection title="Documents">
          <GoogleDocFileSelection key={currentSpace.id} spaceId={currentSpace.id} token={token} />
        </ToolDetailSection>
      ) : null}
      {["googlechat", "feishu", "telegram", "teams"].includes(connector.id) && nativeProviders.includes(connector.id) && token && currentSpace ? (
        <ToolDetailSection title={connector.id === "teams" ? "Teams conversation" : connector.id === "telegram" ? "Telegram groups" : connector.id === "feishu" ? "Feishu groups" : "Google Chat space"}>
          <GoogleChatRoomLink key={`${currentSpace.id}:${connector.id}`} provider={connector.id as "googlechat" | "feishu" | "telegram" | "teams"} spaceId={currentSpace.id} token={token}
            beforeLink={() => ensureConnectionRow(connector)}
            afterRefresh={async () => { await connectionsQuery.refetch(); }} />
        </ToolDetailSection>
      ) : null}
      {[{ id: "dingtalk", label: "DingTalk", Component: DingTalkCompanyConnection },
        { id: "wecom", label: "WeCom", Component: WeComCompanyConnection }].map(({ id, label, Component }) =>
        connector.id === id && nativeProviders.includes(id) && token && currentSpace ? (
          <ToolDetailSection key={id} title={`${label} company application`}>
            <Component key={currentSpace.id} spaceId={currentSpace.id} token={token}
              beforeLink={() => ensureConnectionRow(connector)}
              afterRefresh={async () => { await connectionsQuery.refetch(); }} />
          </ToolDetailSection>
        ) : null)}
      {configuring && selectedConnection && configurationDraft ? (
        <ToolDetailSection title="Configuration">
          <p className="mb-4 text-sm text-muted-foreground">Choose where this connector can run and which write actions are allowed.</p>
          <ConnectorConfiguration
            connector={connector}
            draft={configurationDraft}
            saving={savingProviderId === connector.id}
            onChange={setConfigurationDraft}
            onCancel={closeConnectorConfiguration}
            onSave={() => void saveConnectorConfiguration(connector, selectedConnection)}
            onUpdateProviderAccess={() => void configureConnector(connector, {
              mode: "manage",
              installationId: githubConnectionInstallationIdsFromMetadata(selectedConnection.metadata)[0],
            })}
            onAddProviderAccount={() => void configureConnector(connector, { mode: "add" })}
          />
        </ToolDetailSection>
      ) : (
        <ConnectorDetail connector={connector} connection={selectedConnection} oauth={oauthProviders.includes(connector.id)}
          native={nativeProviders.includes(connector.id)} />
      )}
      {state.configured && connectorWriteActions(connector).length > 0 && token && currentSpace && user?.id ? (
        <ToolDetailSection title="Channel action policy">
          <ConnectorPolicy connector={connector} channels={channels} spaceId={currentSpace.id} token={token} userId={user.id} />
        </ToolDetailSection>
      ) : null}
      {connectorTakesCredentials(connector) && token && currentSpace && user?.id
        && (state.configured || (state.available && connectorWritableCredentials(connector).length > 0)) ? (
        <ToolDetailSection title={connector.id === "wecom" ? "Manual group robot" : ["googlechat", "teams"].includes(connector.id) ? "Manual webhook" : "Credentials"}>
          {["googlechat", "teams"].includes(connector.id) && nativeProviders.includes(connector.id) ? (
            <p className="mb-4 text-sm text-muted-foreground">Saving a manual {connector.id === "teams" ? "Workflows" : "incoming"} webhook replaces the linked app connection.</p>
          ) : connector.id === "feishu" && nativeProviders.includes("feishu") ? (
            <p className="mb-4 text-sm text-muted-foreground">Saving your own app credentials or generating a manual ingress URL replaces all linked company app groups.</p>
          ) : connector.id === "telegram" && nativeProviders.includes("telegram") ? (
            <p className="mb-4 text-sm text-muted-foreground">Saving your own bot credentials or generating a manual ingress URL replaces all linked company bot groups.</p>
          ) : connector.id === "wecom" && nativeProviders.includes("wecom") ? (
            <p className="mb-4 text-sm text-muted-foreground">Saving a group robot webhook key replaces the company installation and its member range. Group robots support outbound messages only.</p>
          ) : null}
          <ConnectorCredentials connector={["googlechat", "wecom", "teams"].includes(connector.id) ? { ...connector, events: undefined } : connector}
            connection={selectedConnection} connected={state.configured}
            spaceId={currentSpace.id} token={token} userId={user.id}
            beforeSave={() => ensureConnectionRow(connector)} afterSave={() => checkConnector(connector)} />
        </ToolDetailSection>
      ) : null}
      {selectedConnection || selectedExecutions.length > 0 ? (
        <ToolDetailSection title="Recent activity">
          <div className="mb-2 flex justify-end">
            <Button size="xs" variant="ghost" onClick={() => void loadExecutions()} disabled={loadingExecutions}
              title="Refresh connector activity">
              <RefreshCw className={cn(loadingExecutions && "animate-spin")} /> Refresh
            </Button>
          </div>
          {executionsError && <p className="mb-3 text-sm font-medium text-destructive">{executionsError}</p>}
          <ConnectorExecutionList executions={selectedExecutions} loading={loadingExecutions} />
        </ToolDetailSection>
      ) : null}
    </ToolDetail>
  ) : null;

  return (
    <div className="app-connectors-view flex min-h-0 min-w-0 flex-1">
      <ToolSplit label="Apps" open={Boolean(connectorItem)} list={list} detail={detail} />
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

export function ConnectorConfiguration({
  connector,
  draft,
  saving,
  onChange,
  onCancel,
  onSave,
  onUpdateProviderAccess,
  onAddProviderAccount,
}: {
  connector: AppConnectorManifest;
  draft: AppConnectorConfigurationDraft;
  saving: boolean;
  onChange: (draft: AppConnectorConfigurationDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onUpdateProviderAccess: () => void;
  onAddProviderAccount: () => void;
}) {
  function update(patch: Partial<AppConnectorConfigurationDraft>) {
    onChange({ ...draft, ...patch });
  }

  return (
    <form
      className="app-connector-configuration space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      {connector.id === "github" ? (
        <div>
          <label className="mb-2 block text-xs font-bold uppercase text-muted-foreground" htmlFor="github-default-repository">
            Default repository
          </label>
          <Input
            id="github-default-repository"
            value={draft.repository}
            onChange={(event) => update({ repository: event.target.value })}
            placeholder="owner/repository"
            pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
          />
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            Used when a channel command contains a short reference such as <code>#42</code>.
          </p>
        </div>
      ) : null}

      {connector.id === "github" ? (
        <fieldset>
          <legend className="mb-1 text-xs font-bold uppercase text-muted-foreground">Workflow dispatch</legend>
          <p className="mb-3 text-xs leading-5 text-muted-foreground">
            Which channels may run each write action is set under Channel action policy.
          </p>
          <div className="space-y-3">
            <label className="grid gap-1.5 text-sm">
              <span className="font-bold">Allowed workflow dispatches</span>
              <Textarea
                value={draft.actionsWorkflowIds}
                onChange={(event) => update({ actionsWorkflowIds: event.target.value })}
                placeholder={"production-release-request.yml\n123456"}
                rows={3}
              />
              <span className="text-xs leading-5 text-muted-foreground">
                One workflow file name or numeric id per line. Dispatch remains disabled for every workflow not listed here.
              </span>
            </label>
          </div>
        </fieldset>
      ) : null}

      {connector.id === "github" ? (
        <div className="app-connector-provider-access border-t border-border/60 pt-4">
          <p className="text-sm font-bold">GitHub repository access</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Each GitHub account or organization keeps its own App installation. Manage repo selection
            for an existing account, or add another account without replacing the first.
            xMatrix does not edit GitHub permissions here.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onUpdateProviderAccess}
              className={cn("app-connector-secondary-action inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-bold", COUNT_CHIP_MATERIAL_CLASS)}
            >
              <GitPullRequest className="size-4" />
              Manage access on GitHub
            </button>
            <button
              type="button"
              onClick={onAddProviderAccount}
              className={cn("app-connector-secondary-action inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-bold", COUNT_CHIP_MATERIAL_CLASS)}
            >
              <Plus className="size-4" />
              Add account or organization
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className={cn("app-connector-secondary-action inline-flex h-9 items-center rounded-md px-3 text-sm font-bold disabled:opacity-50", COUNT_CHIP_MATERIAL_CLASS)}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className={cn("app-connector-primary-action inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50", COUNT_CHIP_MATERIAL_CLASS)}
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          {saving ? "Saving" : "Save configuration"}
        </button>
      </div>
    </form>
  );
}

/* The saved credentials by their manifest labels, e.g. "Integration token". */
function credentialLabels(connector: AppConnectorManifest, fields: readonly string[] | undefined): string {
  return (fields ?? []).map((id) => connector.credentials?.find((field) => field.id === id))
    .filter((field) => field && !field.generated).map((field) => field!.label).join(", ");
}

export function ConnectorDetail({
  connector,
  connection,
  oauth = false,
  native = false,
}: {
  connector: AppConnectorManifest;
  connection?: SerializedAppConnectorConnection;
  /** One-click OAuth is configured for this app on the Hub. */
  oauth?: boolean;
  native?: boolean;
}) {
  const nativeChat = native && ["googlechat", "feishu", "telegram", "teams"].includes(connector.id) && !connection?.credentialFields?.length;
  const configured = connection?.status === "configured";
  const needsAttention = connection?.status === "error";
  const statusLabel = configured
    ? "Connected"
    : needsAttention
      ? "Needs attention"
      : connection
        ? "Disconnected"
        : "Not connected";
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-bold uppercase text-muted-foreground">Connection</p>
        <div
          className={cn(
            "app-connector-setup-state rounded-lg border border-border/70 p-3",
            needsAttention && "border-destructive/30"
          )}
        >
          <div className="flex items-center gap-2">
            {configured ? (
              <Check className="size-4 text-foreground" />
            ) : needsAttention ? (
              <AlertTriangle className="size-4 text-destructive" />
            ) : (
              <Circle className="size-4 text-muted-foreground" />
            )}
            <p className="text-sm font-black">{statusLabel}</p>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {configured
              ? connector.id === "github"
                ? "Repository access is authorized. Connector commands can now run from enabled channels."
                : nativeChat
                  ? `${connector.name} conversations are linked. Connector commands can now run from enabled channels.`
                  : `${connector.name} accepted the saved credentials. Connector commands can now run from enabled channels.`
              : needsAttention
                ? connection?.error || "Reconnect this provider to restore channel delivery."
                : connector.id === "github"
                  ? "Connect the provider, choose the repositories or resources xMatrix may access, then use connector commands in a channel."
                  : native && ["googlechat", "feishu", "telegram", "teams"].includes(connector.id)
                    ? `Link your ${connector.name} ${connector.id === "teams" ? "conversation" : connector.id === "googlechat" ? "space" : "groups"} above, or explicitly configure your own connection below.`
                    : `${oauth ? `Connect with ${connector.name}, or save` : "Save"} the credentials below. xMatrix checks them with ${connector.name} before the app counts as connected.`}
          </p>
        </div>
      </div>

      {configured ? (
        <div className="space-y-2 text-sm text-muted-foreground">
          <DetailRow
            label="Last checked"
            value={connection.lastCheckedAt ? relativeTime(connection.lastCheckedAt) : "Not checked yet"}
          />
          <DetailRow label="Authorization" value={connector.id === "github" ? "GitHub App"
            : nativeChat ? connector.id === "googlechat" ? "Google Chat app" : `${connector.name} company app` : credentialLabels(connector, connection.credentialFields) || "No credentials saved"} />
        </div>
      ) : connector.id === "github" ? (
        <ol className="app-connector-setup-steps space-y-3 text-sm text-muted-foreground">
          <li className="flex gap-3">
            <span className="app-connector-step-number">1</span>
            <span>Connect your provider account.</span>
          </li>
          <li className="flex gap-3">
            <span className="app-connector-step-number">2</span>
            <span>Choose the repositories or resources xMatrix may access.</span>
          </li>
          <li className="flex gap-3">
            <span className="app-connector-step-number">3</span>
            <span>Use a connector command in the channel that should receive updates.</span>
          </li>
        </ol>
      ) : null}

      {connector.id === "github" ? (
        <div>
          <p className="mb-2 text-xs font-bold uppercase text-muted-foreground">Quick start</p>
          <code className="app-connector-command block overflow-x-auto rounded-lg px-3 py-2 font-mono text-xs text-foreground">
            @github:subscribe:OWNER/REPO all
          </code>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Run this in a channel to receive commit, issue, pull request, comment, and review updates from the repository.
          </p>
        </div>
      ) : connector.events ? (
        <div>
          <p className="mb-2 text-xs font-bold uppercase text-muted-foreground">Quick start</p>
          <code className="app-connector-command block overflow-x-auto rounded-lg px-3 py-2 font-mono text-xs text-foreground">
            @{connector.id}:subscribe:{connector.events.source.placeholder}
          </code>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Run this in a channel to receive {connector.name} events. {connector.events.source.description}
          </p>
        </div>
      ) : null}

      <div>
        <p className="mb-2 text-xs font-bold uppercase text-muted-foreground">What you can do</p>
        <div className="app-connector-capabilities divide-y divide-border/60">
          {connector.actions.map((action) => (
            <div key={action.id} className="app-connector-capability flex gap-3 py-2.5 first:pt-0 last:pb-0">
              <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-bold">{action.label}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{action.description}</p>
                {action.usage ? (
                  <code className="mt-1 block font-mono text-xs text-muted-foreground">@{connector.id}:{action.id}:{action.usage}</code>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="app-connector-security-note flex gap-3 border-t border-border/60 pt-4 text-xs leading-5 text-muted-foreground">
        <Shield className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-bold text-foreground">Credentials stay out of chat</p>
          <p>xMatrix uses scoped provider authorization and short-lived credentials for connector actions.</p>
        </div>
      </div>
    </div>
  );
}

export function ConnectorExecutionList({
  executions,
  loading,
}: {
  executions: SerializedAppConnectorExecution[];
  loading: boolean;
}) {
  if (loading && executions.length === 0) {
    return (
      <ListSkeleton label="Loading executions" rows={3} />
    );
  }
  if (executions.length === 0) {
    return <p className="text-sm text-muted-foreground">No executions recorded for this connector yet.</p>;
  }
  return (
    <div className="space-y-3">
      {executions.map((execution) => (
        <div key={execution.id} className="app-connector-card rounded border border-border/70 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-black">{execution.actionLabel || execution.actionId || "Default action"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {relativeTime(execution.createdAt)} by {execution.requestedByLabel || execution.requestedBy}
              </p>
            </div>
            <span
              className={cn(
                "app-connector-status app-status-chip shrink-0 px-2 py-1 text-xs font-bold capitalize",
                COUNT_CHIP_MATERIAL_CLASS,
                appExecutionStatusClassName(execution.status)
              )}
            >
              {execution.status}
            </span>
          </div>
          {execution.resultSummary && <p className="mt-2 text-xs text-muted-foreground">{execution.resultSummary}</p>}
          {execution.reason && <p className="mt-2 text-xs text-muted-foreground">{execution.reason.replace(/_/g, " ")}</p>}
        </div>
      ))}
    </div>
  );
}

/* Ink, not colour: `completed` is the resting state and says nothing extra,
   `queued` is true but not what you are watching for, and the two ways a run
   can stop share the alert ink. */
export function appExecutionStatusClassName(status: SerializedAppConnectorExecution["status"]): string {
  if (status === "blocked" || status === "failed") return "text-destructive";
  if (status === "completed") return "text-foreground";
  return "text-muted-foreground";
}

const CONNECTOR_KIND_ICONS: Partial<Record<AppConnectorManifest["kind"], React.ComponentType<{ className?: string }>>> = {
  "code-host": GitPullRequest,
  webhook: Webhook,
  observability: Bug,
  "issue-tracker": ListTodo,
  incident: Siren,
  chat: MessageSquare,
  deploy: Rocket,
  ci: Rocket,
  gateway: PlugZap,
};

// The same checked-in vendor assets identify Apps and their message authors.
// Stable component identities avoid remounting subscription controls on refresh.
const CONNECTOR_VENDOR_ICONS = new Map(APP_CONNECTOR_PROVIDER_MANIFESTS.map(provider => [provider.id,
  function ConnectorVendorIcon({ className }: { className?: string }) {
    return <Image src={`/app-connectors/${provider.id}.svg`} alt="" width={24} height={24}
      unoptimized className={cn("shrink-0 object-contain", className)} />;
  }]));

export function connectorIcon(connector: AppConnectorManifest): React.ComponentType<{ className?: string }> {
  return CONNECTOR_VENDOR_ICONS.get(connector.id) ?? CONNECTOR_KIND_ICONS[connector.kind] ?? PlugZap;
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
  errorMessage,
} from "./workspace-shell-desktop-labels";

function MachineVersionFacts({ machine }: { machine: MachineSummary }) {
  return <>
    <ToolFact label="Daemon version"><MachineVersionValue version={machine.daemonVersion} /></ToolFact>
    <ToolFact label="CLI version"><MachineVersionValue version={machine.cliVersion} /></ToolFact>
    <ToolFact label="App version"><MachineVersionValue version={machine.appVersion} /></ToolFact>
    <ToolFact label="Last seen">{machine.lastSeenAt ? relativeTime(machine.lastSeenAt) : "-"}</ToolFact>
  </>;
}
