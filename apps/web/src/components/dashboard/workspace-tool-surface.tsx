"use client";

import { DesktopAppUpdateNow } from "./desktop-app-update-now";
import { useMemo } from "react";
import type {
  ChannelSnapshot,
  ObservabilityEvent,
  SerializedAutomation,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";

import { APP_CONNECTORS } from "@/lib/app-connectors";
import type {
  DesktopAgentPresetDiscovery,
  DesktopContext,
  DesktopDaemonStatus,
  DesktopRuntimeCheckResult,
  DesktopSetupStatus,
  DesktopUpdateStatus,
  DesktopWorkspaceCandidate,
} from "@/lib/desktop/bridge";
import type { SpaceJoinRequest } from "@/components/dashboard/space-join-requests";
import { humanProfileFromSpaceMember } from "./human-profile-summary";
import { ProfileView } from "./human-profile-view";
import { MachineHarnessPanel } from "./machine-harness-panel";
import { MachineWorktreesPanel } from "./machine-worktrees-panel";
import { MyAgentsView } from "./my-agents-view";
import { SchedulesView, type ScheduleActions } from "./schedules-view";
import {
  automationsInSpace,
  channelsInSpace,
  eventsInSpace,
  localManagedAgentsInSpace,
  machinesInSpace,
  spaceChannelIdSet,
  workspacesInSpace,
} from "./space-scoped-tool-content";
import { StatusView } from "./status-view";
import { ToolPaper } from "./tool-split";
import { SettingsView, TeamView, type SpaceMemberActions } from "./workspace-settings-team-views";
import {
  ActivityView,
  AppsView,
  LocalMacView,
  MachinesView,
  MoreView,
  THIS_MACHINE_SELECTION,
} from "./workspace-fleet-views";
import { PlatformAdminTabs } from "./workspace-platform-admin-tabs";
import type { LocalManagedAgent, MachineSummary } from "./workspace-shell-helpers";
import type { AppView } from "./workspace-shell-navigation";

// The views behind every destination other than Messages and Pages. The shell
// loads this module when one of them is first shown, so none of these views,
// their charts, billing, connector or admin UI is part of the first screen.

export function ToolSurface({
  view,
  profileUserId,
  user,
  channels,
  machines,
  localWorkspaces,
  localManagedAgents,
  agentPresetDiscoveries,
  loadingAgentPresetDiscoveries,
  automations,
  automationExecutionEnabled,
  spaces,
  currentSpace,
  token,
  events,
  agentsError,
  spacesError,
  desktopAvailable,
  desktopUpdateBridgeAvailable,
  desktopContext,
  desktopDaemonStatus,
  desktopSetupStatus,
  desktopUpdateStatus,
  localActionBusy,
  localActionError,
  automationBusy,
  automationError,
  automationLoadError,
  loadingAutomations,
  scheduleFocusId,
  onScheduleFocusConsumed,
  onOpenPage,
  onOpenConversation,
  runtimeCheck,
  localSetupReady,
  localMachineName,
  onNameLocalMachine,
  onStartDesktopDaemon,
  onStopDesktopDaemon,
  onRestartDesktopDaemon,
  checkingDesktopUpdates,
  onCheckDesktopUpdates,
  onInstallDesktopUpdate,
  onOpenCliInstall,
  onAddLocalWorkspace,
  onRefreshAgentPresetDiscoveries,
  onImportDiscoveredAgent,
  onImportDiscoveredWorkspace,
  onRemoveLocalWorkspace,
  onRevealLocalWorkspace,
  onCheckLocalRuntime,
  onCompleteDesktopSetup,
  onUpdateAutomation,
  onToggleAutomation,
  onRunAutomation,
  onDeleteAutomation,
  joinRequestsBySpace,
  onDecideJoinRequest,
  onCreateSpaceInviteCode,
  onInviteSpaceMembers,
  onUpdateSpaceMemberRole,
  onRemoveSpaceMember,
  onUpdateSpaceMemberPermissions,
  onUpdateSpacePreferredLanguage,
  onDeleteSpace,
  onRestoreSpace,
  creatingSpace,
  onCreateSpace,
  onSelectSpace,
  onLogout,
  onOpenAgentCreate,
  onOpenLocalManagedAgentEdit,
  onDeleteAgent,
  onChangeView,
  onReportIssue,
  platformAdmin,
}: {
  view: Exclude<AppView, "messages">;
  /** Whose profile the Profile view shows; null is the viewer's own. */
  profileUserId: string | null;
  user: { id: string; email: string; name?: string };
  /** Hub-reported operator capability; the admin route re-checks it. */
  platformAdmin?: boolean;
  channels: ChannelSnapshot[];
  machines: MachineSummary[];
  localWorkspaces: SerializedWorkspace[];
  localManagedAgents: LocalManagedAgent[];
  agentPresetDiscoveries: DesktopAgentPresetDiscovery[];
  loadingAgentPresetDiscoveries: boolean;
  automations: SerializedAutomation[];
  automationExecutionEnabled: boolean | null;
  spaces: SerializedSpace[];
  currentSpace: SerializedSpace | null;
  token?: string;
  events: ObservabilityEvent[];
  agentsError: string | null;
  spacesError: string | null;
  desktopAvailable: boolean;
  desktopUpdateBridgeAvailable: boolean;
  desktopContext: DesktopContext | null;
  desktopDaemonStatus: DesktopDaemonStatus | null;
  desktopSetupStatus: DesktopSetupStatus | null;
  desktopUpdateStatus: DesktopUpdateStatus | null;
  localActionBusy: string | null;
  localActionError: string | null;
  automationBusy: string | null;
  automationError: string | null;
  automationLoadError: string | null;
  loadingAutomations: boolean;
  /** An Automation Schedules opens for editing. */
  scheduleFocusId: string | null;
  onScheduleFocusConsumed: () => void;
  onOpenPage: (pageId: string) => void;
  onOpenConversation: (channelId: string) => void;
  runtimeCheck: DesktopRuntimeCheckResult | null;
  localSetupReady: boolean;
  localMachineName: string | null | undefined;
  onNameLocalMachine: (name: string) => void;
  onStartDesktopDaemon: () => void;
  onStopDesktopDaemon: () => void;
  onRestartDesktopDaemon: () => void;
  checkingDesktopUpdates: boolean;
  onCheckDesktopUpdates: () => void;
  onInstallDesktopUpdate: () => void;
  onOpenCliInstall: () => void;
  onAddLocalWorkspace: () => void;
  onRefreshAgentPresetDiscoveries: () => void;
  onImportDiscoveredAgent: (discovery: DesktopAgentPresetDiscovery) => void;
  onImportDiscoveredWorkspace: (candidate: DesktopWorkspaceCandidate) => void;
  onRemoveLocalWorkspace: (workspace: SerializedWorkspace) => void;
  onRevealLocalWorkspace: (workspace: SerializedWorkspace) => void;
  onCheckLocalRuntime: (runtime: string) => void;
  onCompleteDesktopSetup: () => void;
  joinRequestsBySpace: Record<string, SpaceJoinRequest[]>;

  creatingSpace: boolean;
  onCreateSpace: (name: string) => Promise<SerializedSpace | undefined>;
  onSelectSpace: (spaceId: string) => void;
  onLogout: () => void;
  onOpenAgentCreate: () => void;
  onOpenLocalManagedAgentEdit: () => void;
  onDeleteAgent: (agent: LocalManagedAgent) => void;
  onChangeView: (view: AppView, selection?: string) => void;
  /** Opens the GitHub issue form for a report. */
  onReportIssue?: () => void;
} & SpaceMemberActions & ScheduleActions) {
  const currentSpaceChannelIds = useMemo(
    () => spaceChannelIdSet(channels, currentSpace?.id),
    [channels, currentSpace?.id],
  );
  const currentSpaceChannels = useMemo(
    () => channelsInSpace(channels, currentSpace?.id),
    [channels, currentSpace?.id],
  );
  const currentSpaceMachines = useMemo(
    () => machinesInSpace(machines, currentSpaceChannelIds, { ownerUserId: user.id }),
    [currentSpaceChannelIds, machines, user.id],
  );
  const currentSpaceLocalWorkspaces = useMemo(
    () => workspacesInSpace(localWorkspaces, currentSpaceChannelIds, { includeUnbound: true }),
    [currentSpaceChannelIds, localWorkspaces],
  );
  const currentSpaceLocalAgents = useMemo(
    () => localManagedAgentsInSpace(localManagedAgents, currentSpace?.id),
    [currentSpace?.id, localManagedAgents],
  );
  // Every Channel this account can see, so an Automation pinned to a Channel that no
  // longer exists stays visible instead of being read as another Space's.
  const knownChannelIds = useMemo(
    () => new Set(channels.map((channel) => channel.id)),
    [channels],
  );
  const currentSpaceAutomations = useMemo(
    () => automationsInSpace(automations, currentSpaceChannelIds, knownChannelIds),
    [currentSpaceChannelIds, knownChannelIds, automations],
  );
  const currentSpaceEvents = useMemo(
    () => eventsInSpace(events, currentSpace?.id, currentSpaceChannelIds),
    [currentSpace?.id, currentSpaceChannelIds, events],
  );

  // Schedules is read on the workspace panel's paper, like a page, not on the tools' board.
  if (view === "automation") {
    return (
      <SchedulesView
        spaceId={currentSpace?.id ?? null}
        token={token ?? ""}
        automations={currentSpaceAutomations}
        executionEnabled={automationExecutionEnabled}
        spaces={spaces}
        currentUserId={user.id}
        channels={currentSpaceChannels}
        busy={automationBusy}
        error={automationError}
        loadError={automationLoadError}
        loadingAutomations={loadingAutomations}
        focusAutomationId={scheduleFocusId ?? undefined}
        onFocusConsumed={onScheduleFocusConsumed}
        onUpdateAutomation={onUpdateAutomation}
        onToggleAutomation={onToggleAutomation}
        onRunAutomation={onRunAutomation}
        onDeleteAutomation={onDeleteAutomation}
        onOpenPage={onOpenPage}
        onOpenConversation={onOpenConversation}
        onOpenPages={() => onChangeView("pages")}
      />
    );
  }

  if (view === "admin") return <PlatformAdminTabs token={token} />;
  if (view === "team") {
    return (
      <TeamView
        token={token}
        user={user}
        currentSpace={currentSpace}
        error={spacesError}
        joinRequestsBySpace={joinRequestsBySpace}
        onDecideJoinRequest={onDecideJoinRequest}
        onCreateSpaceInviteCode={onCreateSpaceInviteCode}
        onInviteSpaceMembers={onInviteSpaceMembers}
        onUpdateSpaceMemberRole={onUpdateSpaceMemberRole}
        onRemoveSpaceMember={onRemoveSpaceMember}
        onUpdateSpaceMemberPermissions={onUpdateSpaceMemberPermissions}
        onUpdateSpacePreferredLanguage={onUpdateSpacePreferredLanguage}
        onDeleteSpace={onDeleteSpace}
        onRestoreSpace={onRestoreSpace}
        spaces={spaces}
        creatingSpace={creatingSpace}
        onCreateSpace={onCreateSpace}
        onSelectSpace={onSelectSpace}
      />
    );
  }
  // Status: the Space at work, opening into Agents, Machines and Schedules.
  if (view === "status") {
    return (
      <StatusView
        spaceId={currentSpace?.id ?? null}
        token={token}
        currentUserId={user.id}
        machines={currentSpaceMachines}
        channels={currentSpaceChannels}
        events={currentSpaceEvents}
        automations={currentSpaceAutomations}
        executionEnabled={automationExecutionEnabled}
        onOpenAgent={(registrationId) => onChangeView("agents", registrationId)}
        onOpenAgents={() => onChangeView("agents")}
        onOpenMachine={(machineId) => onChangeView("machines", machineId)}
        onOpenMachines={() => onChangeView("machines")}
        onOpenSchedule={(automationId) => onChangeView("automation", automationId)}
        onOpenSchedules={() => onChangeView("automation")}
      />
    );
  }
  // Agents: the Space's registered agents, each opened beside the list.
  if (view === "agents") {
    return (
      <MyAgentsView
        spaceId={currentSpace?.id ?? null}
        token={token}
        currentUserId={user.id}
        error={agentsError}
        addsOnThisMachine={Boolean(desktopContext?.machineId)}
        channels={currentSpaceChannels}
        onOpenConversation={onOpenConversation}
        onOpenMachines={() => onChangeView("machines")}
      />
    );
  }
  if (view === "apps") {
    return (
      <AppsView
        connectors={APP_CONNECTORS}
        currentSpace={currentSpace}
        token={token}
      />
    );
  }
  // On the desktop app this machine is a tagged row of Machines, not a destination of its own.
  if (view === "machines" || view === "local") {
    const localDirectories = currentSpaceLocalWorkspaces.length;
    return (
      <MachinesView
        machines={currentSpaceMachines}
        loading={false}
        error={agentsError}
        token={token}
        spaceId={currentSpace?.id}
        defaultMachineId={view === "local" ? THIS_MACHINE_SELECTION : undefined}
        thisMachine={desktopAvailable && desktopContext
          && !["ios", "android"].includes(desktopContext.platform) ? {
          machineId: desktopContext?.machineId,
          name: "Unnamed machine",
          online: desktopDaemonStatus?.state === "running",
          platform: desktopContext?.platform,
          app: {
            version: desktopContext.version,
            update: <DesktopAppUpdateNow status={desktopUpdateBridgeAvailable ? desktopUpdateStatus : null}
              checking={checkingDesktopUpdates} onCheck={onCheckDesktopUpdates} onInstall={onInstallDesktopUpdate} />,
          },
          summary: `${desktopDaemonStatus?.state === "running" ? "Daemon online" : "Daemon offline"} · ${localDirectories} ${localDirectories === 1 ? "directory" : "directories"}`,
          content: (hubRecord) => (
        <LocalMacView
          hubRecord={hubRecord}
          desktopAvailable={desktopAvailable}
          desktopContext={desktopContext}
          desktopDaemonStatus={desktopDaemonStatus}
          desktopSetupStatus={desktopSetupStatus}
          workspaces={currentSpaceLocalWorkspaces}
          agents={currentSpaceLocalAgents}
          discoveries={agentPresetDiscoveries}
          loadingDiscoveries={loadingAgentPresetDiscoveries}
          busy={localActionBusy}
          error={localActionError}
          runtimeCheck={runtimeCheck}
          setupReady={localSetupReady}
          machineName={localMachineName}
          onNameMachine={onNameLocalMachine}
          harnesses={<MachineHarnessPanel key={currentSpace?.id} token={token} spaceId={currentSpace?.id}
            daemon={machines.find(machine => machine.machineId === desktopContext?.machineId)?.daemon} />}
          worktrees={<MachineWorktreesPanel token={token}
            daemon={machines.find(machine => machine.machineId === desktopContext?.machineId)?.daemon} />}
          onStartDaemon={onStartDesktopDaemon}
          onRestartDaemon={onRestartDesktopDaemon}
          onOpenCliInstall={onOpenCliInstall}
          onRefreshDiscoveries={onRefreshAgentPresetDiscoveries}
          onAddWorkspace={onAddLocalWorkspace}
          onImportAgent={onImportDiscoveredAgent}
          onImportWorkspace={onImportDiscoveredWorkspace}
          onRemoveWorkspace={onRemoveLocalWorkspace}
          onRevealWorkspace={onRevealLocalWorkspace}
          onCreateAgent={onOpenAgentCreate}
          onEditAgent={onOpenLocalManagedAgentEdit}
          onDeleteAgent={onDeleteAgent}
          onCheckRuntime={onCheckLocalRuntime}
          onCompleteSetup={onCompleteDesktopSetup}
        />
          ),
        } : null}
      />
    );
  }
  if (view === "settings") {
    return (
      <SettingsView
        user={user}
        space={currentSpace ? { id: currentSpace.id, name: currentSpace.name } : null}
        projectedProfile={humanProfileFromSpaceMember(
          user,
          currentSpace?.members.find((member) => member.userId === user.id),
        )}
        token={token}
        onChangeView={onChangeView}
        desktopAvailable={desktopAvailable}
        desktopUpdateBridgeAvailable={desktopUpdateBridgeAvailable}
        desktopContext={desktopContext}
        desktopDaemonStatus={desktopDaemonStatus}
        desktopUpdateStatus={desktopUpdateStatus}
        onStartDesktopDaemon={onStartDesktopDaemon}
        onStopDesktopDaemon={onStopDesktopDaemon}
        onRestartDesktopDaemon={onRestartDesktopDaemon}
        checkingDesktopUpdates={checkingDesktopUpdates}
        onCheckDesktopUpdates={onCheckDesktopUpdates}
        onInstallDesktopUpdate={onInstallDesktopUpdate}
        onLogout={onLogout}
      />
    );
  }

  return (
    <ToolPaper label={view === "activity" ? "Activity" : view === "profile" ? "Profile" : "More"}>
      {view === "activity" && (
        <ActivityView events={currentSpaceEvents} />
      )}
      {view === "profile" && (
        <ProfileView
          user={user}
          member={currentSpace?.members.find(
            (candidate) => candidate.userId === (profileUserId ?? user.id),
          )}
          self={!profileUserId || profileUserId === user.id}
          token={token}
        />
      )}
      {view === "more" && (
        <MoreView
          profile={humanProfileFromSpaceMember(
            user,
            currentSpace?.members.find((member) => member.userId === user.id),
          )}
          platformAdmin={platformAdmin}
          onChangeView={onChangeView}
          onReportIssue={onReportIssue}
        />
      )}
    </ToolPaper>
  );
}
