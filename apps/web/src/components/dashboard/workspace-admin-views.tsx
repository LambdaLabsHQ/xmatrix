"use client";
import { PrivateSignInEmail } from "./private-sign-in-email";

import { actionClass } from "@/components/ui/action-tone";
import { ChannelTransferQueue } from "./channel-transfer-queue";
import { spaceSummary, TeamNewSpace, TeamOtherSpace } from "./team-spaces";
import { SpaceDangerZone } from "./space-deletion-panel";
import { SpaceOpenParticipation } from "./space-open-participation";
import { withChannelReadState, type ChannelReadStateUpdate } from "./channel-read-state";
import type {
  AgentConfigForm,
} from "./workspace-shell-agent-config-types";

import {
  desktopDaemonLabel,
  desktopUpdateDescription,
  desktopUpdateLabel,
  errorMessage,
} from "./workspace-shell-desktop-labels";

import { type AppView } from "./workspace-shell-navigation";

import {
  COUNT_CHIP_MATERIAL_CLASS,
  WORKING_SPACE_KV_KEY,
  XMATRIX_RELEASE_VERSION,
} from "./workspace-shell-constants";

import {
  agentPresetOrCustom,
  formatVersion,
  hasQuotaMeterUsage,
  isChannelAttentionSummary,
  mergeAccountLevelLlmUsage,
  releaseVersionStatus,
  spacePreferredLanguage,
  validChannelReadSequence,
} from "./workspace-shell-formatters";

import {
  LlmUsage,
  SpaceInviteResult,
  SpaceInviteRole,
  SpaceMemberActionResult,
  presentationAttachmentKind,
} from "./workspace-shell-helpers";

import {
  earliestTimestamp,
  compareChannelsForSidebar,
  latestTimestamp,
  sortChannels,
  sortProjects,
  sortAutomations,
  sortSpaces,
  timestampMs,
} from "./workspace-shell-helpers-extra";

import {
  noteChannelContentRevision,
  parseChannelContentRevision,
} from "@/lib/relay-v2/channel-content-revision";
import { mergeSpaceSnapshot } from "./workspace-space-snapshot";
import type { SpaceJoinRequest } from "@/components/dashboard/space-join-requests";
import { HumanProfileSummary } from "@/components/dashboard/human-profile-summary";
import {
  XMATRIX_CLIENT_ENVIRONMENTS,
  clientAppUrl,
  clientEnvironmentForHostname,
  type XMatrixClientEnvironment,
} from "@/lib/client-environment";
import { useAuthCapability } from "@/components/dashboard/use-platform-admin-capability";
import {
} from "@/components/dashboard/human-profile-editor";
import {
  canInviteToSpace,
  isValidChannelMessage,
  parseInviteEmails,
  relativeTime,
  shortId,
  spaceRoleFor,
} from "./workspace-shell-recovered";

import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  creationPolicyFromSwitch,
  effectiveSpaceMemberPermissions,
} from "./space-member-permissions";

import {
  mergeChannelViewerState,
  type ChannelViewerStateAuthority,
} from "./channel-viewer-state";

import { ListSkeleton } from "./content-skeleton";
import {
  AlertTriangle,
  Building,
  Check,
  ChevronRight,
  CircleArrowUp,
  Key,
  Link as LinkIcon,
  Loader2,
  LogOut,
  Mail,
  Pencil,
  Plus,
  PlusCircle,
  Radio,
  RefreshCw,
  Send,
  Shield,
  CreditCard,
  Trash2,
  UserRound,
  Globe,
  Monitor,
  X,
} from "lucide-react";
import { SectionedToolView, type ToolSection } from "./tool-split";
import { spacePlansAbsent } from "./space-plan-mark";
import {
  SPACE_BILLING_SECTION,
  SpaceBillingSection,
  spaceBillingSummary,
  useSpaceBilling,
} from "./settings-billing";

import { Textarea } from "@/components/ui/textarea";

import { GlassSelect } from "@/components/ui/glass-select";

import { Input } from "@/components/ui/input";

import { LiquidGlassCard, WoodPanel } from "@/components/ui/material-surfaces";
import { noticeClass, statusChipClass } from "@/components/ui/status-tone";

import {
  filterHistoryForChannel,
} from "@/components/dashboard/channel-history";

import {
  workspaceKey,
} from "@/components/dashboard/agent-workspaces";

import {
  CHANNEL_CATALOG_FETCH_TOTAL_TIMEOUT_MS,
  runWorkspaceFetchWithRetry,
  workspaceAttemptSignal,
} from "@/components/dashboard/workspace-refresh-policy";

import {
  buildSecretCatalogSavePayload,
  normalizeSecretCatalogEntry,
  normalizeSecretCatalogList,
  secretCatalogFormDraft,
  validateSecretCatalogDraft,
  type SecretCatalogFormDraft,
  type SecretCatalogFormMode,
  type SpaceSecretAccess,
  type SpaceSecretEntry,
} from "@/components/dashboard/secret-catalog";

import {
  getDesktopBridge,
  type DesktopContext,
  type DesktopDaemonStatus,
  type DesktopUpdateStatus,
  type DesktopWorkspaceCandidate,
} from "@/lib/desktop/bridge";

import { cn } from "@/lib/utils";
import { xmatrixApiRequest, requireResponseOk } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import type {
  ChannelAttentionSnapshot,
  ChannelCatalogSyncMetadata,
  ChannelMessage,
  ChannelMemberPresence,
  ManagementChannelVisibility,
  ObservabilityEvent,
  SerializedAgent,
  SerializedAgentInstance,
  SerializedChannel,
  SerializedMachineDaemon,
  SerializedAutomation,
  SerializedAutomationCatalog,
  AutomationExpressionInput,
  AutomationUpdateRequest,
  SerializedSpace,
  SpaceMemberPermissions,
  SerializedWorkspace,
  HumanProfile,
} from "@xmatrix/protocol";

// Semantic module extracted from workspace-app-shell (AST-safe)

export function mergeLlmUsagePreferringQuotas(
  current?: LlmUsage,
  update?: LlmUsage
): LlmUsage | undefined {
  if (!update) return current;
  if (!current) return update;
  if (update.quotaState || current.quotaState) {
    return mergeAccountLevelLlmUsage(current, update);
  }
  if (hasQuotaMeterUsage(update)) {
    const previousTime = Date.parse(current.quotaObservedAt ?? "");
    const incomingTime = Date.parse(update.quotaObservedAt ?? "");
    // Concurrent frames can arrive out of order. Token counters may advance
    // without replacing a newer provider sample.
    if (Number.isFinite(previousTime) && Number.isFinite(incomingTime) && incomingTime < previousTime) {
      const {
        quotaSource: _quotaSource,
        quotaUsages: _quotaUsages,
        quotaObservedAt: _quotaObservedAt,
        quotaAccount: _quotaAccount,
        ...localUsage
      } = update;
      return { ...current, ...localUsage };
    }
    return update;
  }
  if (hasQuotaMeterUsage(current)) {
    return {
      ...current,
      ...update,
      quotaSource: "provider_api",
      quotaUsages: current.quotaUsages,
      quotaAccount: current.quotaAccount,
      ...(current.quotaObservedAt ? { quotaObservedAt: current.quotaObservedAt } : {}),
    };
  }
  return update;
}

/* Access is told in ink on the chip material the call site already wears:
   `auto` is the resting state, `ask` asks a person each time. */
export function secretAccessChipClass(access: SpaceSecretAccess): string {
  return access === "ask" ? "app-status-chip app-status-chip-attention" : "app-status-chip";
}

/** Settings' one update action: restart into a downloaded version, or check now. */
function DesktopUpdateAction({
  status,
  checking,
  onCheck,
  onInstall,
}: {
  status: DesktopUpdateStatus;
  checking: boolean;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const className = actionClass({ variant: "secondary", size: "lg" }, "mt-4 w-full sm:h-9 sm:px-3");
  if (status.state === "downloaded" || status.state === "available" || status.state === "installing") {
    const installing = status.state === "installing";
    const version = status.version ? ` ${status.version}` : "";
    return (
      <button type="button" onClick={onInstall} disabled={installing} className={className}>
        {installing ? <Loader2 className="size-4 animate-spin" /> : <CircleArrowUp className="size-4" />}
        {installing
          ? "Restarting"
          : status.state === "available"
            ? `Download${version}`
            : `Restart to update to${version || " the new version"}`}
      </button>
    );
  }
  const busy = checking || status.state === "checking" || status.state === "downloading";
  return (
    <button type="button" onClick={onCheck} disabled={busy} className={className}>
      <RefreshCw className={cn("size-4", busy && "animate-spin")} />
      Check for updates
    </button>
  );
}

export function SettingsView({
  user,
  space,
  projectedProfile,
  token,
  onChangeView,
  desktopAvailable,
  desktopUpdateBridgeAvailable,
  desktopContext,
  desktopDaemonStatus,
  desktopUpdateStatus,
  onStartDesktopDaemon,
  onStopDesktopDaemon,
  onRestartDesktopDaemon,
  checkingDesktopUpdates,
  onCheckDesktopUpdates,
  onInstallDesktopUpdate,
  onLogout,
}: {
  user: { id: string; email: string; name?: string; avatarUrl?: string };
  /** The Space whose secrets this lists; secrets belong to a Space. */
  space: { id: string; name: string } | null;
  projectedProfile: HumanProfile;
  token?: string;
  onChangeView: (view: AppView) => void;
  desktopAvailable: boolean;
  desktopUpdateBridgeAvailable: boolean;
  desktopContext: DesktopContext | null;
  desktopDaemonStatus: DesktopDaemonStatus | null;
  desktopUpdateStatus: DesktopUpdateStatus | null;
  onStartDesktopDaemon: () => void;
  onStopDesktopDaemon: () => void;
  onRestartDesktopDaemon: () => void;
  checkingDesktopUpdates: boolean;
  onCheckDesktopUpdates: () => void;
  onInstallDesktopUpdate: () => void;
  onLogout: () => void;
}) {
  const queryClient = useQueryClient();
  const daemonRunning = desktopDaemonStatus?.state === "running";
  const daemonBusy = desktopDaemonStatus?.state === "starting";
  const [profile, setProfile] = useState<HumanProfile>(() => projectedProfile);
  const [secretActionError, setSecretCatalogError] = useState<string | null>(null);
  const [secretEditor, setSecretEditor] = useState<{
    mode: SecretCatalogFormMode;
    draft: SecretCatalogFormDraft;
    error: string | null;
  } | null>(null);
  const [confirmingSecretRef, setConfirmingSecretRef] = useState<string | null>(null);
  const [clientEnvironment, setClientEnvironment] = useState<XMatrixClientEnvironment>("production");
  const [environmentSwitchError, setEnvironmentSwitchError] = useState<string | null>(null);
  const [environmentSwitching, setEnvironmentSwitching] = useState(false);
  const testEnvironmentAllowed = useAuthCapability("testEnvironment", token);
  const secretKey = xmatrixQueryKeys.domain({ userId: user.id }, "space-secrets", [space?.id ?? ""]);
  const secretQuery = useQuery({
    queryKey: secretKey,
    queryFn: ({ signal }) => xmatrixApiRequest<{ secrets?: unknown[]; canManage?: boolean }>({
      url: WEB_PROXY_ROUTES.space_secrets(space!.id), token, signal,
    }).then(normalizeSecretCatalogList),
    enabled: Boolean(token && space),
  });
  const secretMutation = useMutation({
    mutationKey: [...secretKey, "command"],
    mutationFn: (input: {
      kind: "save" | "delete";
      route: string;
      method: "PUT" | "DELETE";
      body?: unknown;
      secretRef?: string;
    }) => xmatrixApiRequest<{ secret?: unknown }>({
      url: input.route, method: input.method, token, body: input.body,
    }),
  });
  const spaceBillingQuery = useSpaceBilling(user.id, space?.id ?? null);
  const secretCatalogEntries = secretQuery.data?.secrets ?? [];
  const canManageSecrets = secretQuery.data?.canManage === true;
  const secretCatalogLoaded = secretQuery.isFetched;
  const secretCatalogLoading = secretQuery.isFetching;
  const secretCatalogError = secretActionError ?? secretQuery.error?.message ?? null;
  const secretSaving = secretMutation.isPending && secretMutation.variables?.kind === "save";
  const deletingSecretRef = secretMutation.isPending && secretMutation.variables?.kind === "delete"
    ? secretMutation.variables.secretRef ?? null : null;

  useEffect(() => {
    setClientEnvironment(clientEnvironmentForHostname(window.location.hostname));
  }, []);

  async function switchEnvironment(environment: XMatrixClientEnvironment) {
    if (environment === clientEnvironment || environmentSwitching) return;
    if (environment === "test" && !testEnvironmentAllowed) return;
    const confirmed = window.confirm(
      `Switch to ${XMATRIX_CLIENT_ENVIRONMENTS[environment].label}? This opens a separate account and data environment.`,
    );
    if (!confirmed) return;

    setEnvironmentSwitchError(null);
    setEnvironmentSwitching(true);
    try {
      await getDesktopBridge()?.switchEnvironment?.(environment);
      window.location.assign(clientAppUrl(environment));
    } catch (error) {
      setEnvironmentSwitchError(errorMessage(error, "Could not switch environments."));
      setEnvironmentSwitching(false);
    }
  }

  useEffect(() => {
    setProfile((current) => {
      if (current.userId !== projectedProfile.userId) return projectedProfile;
      return projectedProfile.profileVersion > current.profileVersion ? projectedProfile : current;
    });
  }, [projectedProfile]);

  const loadSecretCatalog = useCallback(async () => {
    setSecretCatalogError(null);
    await secretQuery.refetch();
  }, [secretQuery]);

  function openSecretEditor(mode: SecretCatalogFormMode, entry?: SpaceSecretEntry) {
    setConfirmingSecretRef(null);
    setSecretEditor({
      mode,
      draft: secretCatalogFormDraft(entry),
      error: null,
    });
  }

  function updateSecretDraft(patch: Partial<SecretCatalogFormDraft>) {
    setSecretEditor((current) =>
      current
        ? {
            ...current,
            draft: { ...current.draft, ...patch },
            error: null,
          }
        : current
    );
  }

  async function submitSecretCatalog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secretEditor || secretSaving) return;
    if (!token || !space) {
      setSecretEditor((current) =>
        current ? { ...current, error: "Open a Space to manage its secrets." } : current
      );
      return;
    }
    const validationError = validateSecretCatalogDraft(secretEditor.draft, secretEditor.mode);
    if (validationError) {
      setSecretEditor((current) => (current ? { ...current, error: validationError } : current));
      return;
    }

    try {
      const payload = await secretMutation.mutateAsync({
        kind: "save",
        route: WEB_PROXY_ROUTES.space_secrets(space.id),
        method: "PUT",
        body: buildSecretCatalogSavePayload(secretEditor.draft),
      });
      const saved = normalizeSecretCatalogEntry(payload.secret);
      if (saved) {
        queryClient.setQueryData<ReturnType<typeof normalizeSecretCatalogList>>(secretKey, (current) => current && {
          ...current,
          secrets: [...current.secrets.filter((entry) => entry.secretRef !== saved.secretRef), saved]
            .sort((left, right) => left.secretRef.localeCompare(right.secretRef)),
        });
      } else {
        await loadSecretCatalog();
      }
      setSecretEditor(null);
      setSecretCatalogError(null);
    } catch (err) {
      setSecretEditor((current) =>
        current ? { ...current, error: errorMessage(err, "Could not save secret.") } : current
      );
    }
  }

  async function deleteSecret(entry: SpaceSecretEntry) {
    if (!token || !space || deletingSecretRef) return;
    setSecretCatalogError(null);
    try {
      await secretMutation.mutateAsync({
        kind: "delete",
        route: WEB_PROXY_ROUTES.space_secrets(space.id, entry.secretRef),
        method: "DELETE",
        secretRef: entry.secretRef,
      });
      queryClient.setQueryData<ReturnType<typeof normalizeSecretCatalogList>>(secretKey, (current) => current && {
        ...current, secrets: current.secrets.filter((secret) => secret.secretRef !== entry.secretRef),
      });
      setConfirmingSecretRef(null);
      setSecretEditor((current) =>
        current?.draft.secretRef === entry.secretRef ? null : current
      );
    } catch (err) {
      setSecretCatalogError(errorMessage(err, "Could not delete secret."));
    }
  }

  // Settings reads like the other rail destinations: its sections in the list, one on the paper.
  const sections: ToolSection[] = [
    { key: "account", label: "Account", icon: UserRound, summary: user.email, content: (
        <div className="app-settings-section min-w-0">
          <div className="mb-4 flex flex-col items-start gap-3 min-[390px]:flex-row min-[390px]:items-center min-[390px]:justify-between">
            {/* Editing lives on the Profile view. Two editors would be two
                sources of truth for the same fields. */}
            <button
              type="button"
              onClick={() => onChangeView("profile")}
              className={actionClass({ variant: "secondary", size: "sm" }, "w-full min-[390px]:w-auto")}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              Edit profile
            </button>
          </div>
          <HumanProfileSummary profile={profile} />
          <PrivateSignInEmail
            email={user.email}
            className="mt-4 flex items-start gap-3 border-t border-border/60 pt-4"
            emailClassName="mt-1 truncate text-sm text-muted-foreground"
          />
        </div>
      ) },
    ...(testEnvironmentAllowed || clientEnvironment === "test" ? [{
      key: "environment", label: "Environment", icon: Globe,
      summary: XMATRIX_CLIENT_ENVIRONMENTS[clientEnvironment].label, content: (
        <div className="app-settings-section min-w-0">
            <p className="mt-1 text-sm text-muted-foreground">
              Production and Test have separate accounts, sessions, and data.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
              {(Object.keys(XMATRIX_CLIENT_ENVIRONMENTS) as XMatrixClientEnvironment[]).map((environment) => (
                <button
                  key={environment}
                  type="button"
                  aria-pressed={clientEnvironment === environment}
                  disabled={environmentSwitching || (environment === "test" && !testEnvironmentAllowed)}
                  onClick={() => void switchEnvironment(environment)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-sm font-bold transition-colors disabled:opacity-50",
                    clientEnvironment === environment
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-muted",
                  )}
                >
                  {environmentSwitching && clientEnvironment !== environment ? "Switching…" : XMATRIX_CLIENT_ENVIRONMENTS[environment].label}
                </button>
              ))}
            </div>
            {clientEnvironment === "test" ? (
              <p className={noticeClass("attention", "mt-3 text-xs")}>
                Test is isolated and may require Cloudflare Access.
              </p>
            ) : null}
            {environmentSwitchError ? (
              <p className="mt-3 text-sm text-destructive">{environmentSwitchError}</p>
            ) : null}
          </div>
      ),
    }] : []),
    { key: "secrets", label: "Secrets", icon: Key,
      summary: secretCatalogLoaded ? `${secretCatalogEntries.length} in ${space?.name ?? "this Space"}` : "Stored values are never shown", content: (
        <div className="app-settings-section min-w-0">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Secrets belong to {space?.name ?? "the Space"}. An Agent reads one when it needs it: an <b>auto</b> secret
                right away, an <b>ask</b> secret after a Space admin approves that Agent on a card in its Channel.
                Stored values are never shown.
              </p>
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:items-center">
              {canManageSecrets && <button
                type="button"
                onClick={() => openSecretEditor("create")}
                disabled={!token || secretSaving}
                className={actionClass({ variant: "primary", size: "lg" }, "min-w-0 sm:h-9 sm:px-3")}
              >
                <Plus className="size-4" />
                New secret
              </button>}
              <button
                type="button"
                onClick={() => void loadSecretCatalog()}
                disabled={!token || secretCatalogLoading}
                className={actionClass({ variant: "secondary", size: "lg" }, "min-w-0 sm:h-9 sm:px-3")}
              >
                <RefreshCw className={cn("size-4", secretCatalogLoading && "animate-spin")} />
                Refresh
              </button>
            </div>
          </div>

          {secretCatalogError && (
            <div className="mb-4 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {secretCatalogError}
            </div>
          )}

          {secretEditor && (
            <form onSubmit={submitSecretCatalog} className="mb-4 border-y border-border py-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-bold">
                  <span>Alias</span>
                  <Input
                    value={secretEditor.draft.secretRef}
                    onChange={(event) => updateSecretDraft({ secretRef: event.target.value })}
                    disabled={secretEditor.mode === "edit" || secretSaving}
                    placeholder="api-dev-key"
                    className="h-9 font-mono"
                  />
                </label>
                <label className="grid gap-1 text-sm font-bold">
                  <span>Value</span>
                  <Input
                    type="password"
                    value={secretEditor.draft.value}
                    onChange={(event) => updateSecretDraft({ value: event.target.value })}
                    disabled={secretSaving}
                    placeholder={secretEditor.mode === "create" ? "Required for new secret" : "Leave empty to keep existing value"}
                    autoComplete="off"
                    className="h-9"
                  />
                </label>
                <label className="grid gap-1 text-sm font-bold">
                  <span>Env</span>
                  <Input
                    value={secretEditor.draft.envName}
                    onChange={(event) => updateSecretDraft({ envName: event.target.value })}
                    disabled={secretSaving}
                    placeholder="PROVIDER_API_KEY"
                    className="h-9 font-mono"
                  />
                </label>
                <label className="grid gap-1 text-sm font-bold">
                  <span>Agents get it</span>
                  <GlassSelect
                    value={secretEditor.draft.access}
                    onChange={(value) => updateSecretDraft({ access: value as SpaceSecretAccess })}
                    options={[
                      { value: "auto", label: "Automatically" },
                      { value: "ask", label: "After an admin approves" },
                    ]}
                    disabled={secretSaving}
                    className="rounded border-input font-bold transition focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                  />
                </label>
                <label className="grid gap-1 text-sm font-bold sm:col-span-2">
                  <span>Description</span>
                  <Textarea
                    value={secretEditor.draft.description}
                    onChange={(event) => updateSecretDraft({ description: event.target.value })}
                    disabled={secretSaving}
                    placeholder="Local model API experiments"
                    className="min-h-20"
                  />
                </label>
              </div>
              {secretEditor.error && (
                <p className="mt-3 text-sm font-medium text-destructive">{secretEditor.error}</p>
              )}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
                <button
                  type="button"
                  onClick={() => setSecretEditor(null)}
                  disabled={secretSaving}
                  className={actionClass({ variant: "secondary", size: "lg" }, "min-w-0 sm:h-9")}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={secretSaving}
                  className={actionClass({ variant: "primary", size: "lg" }, "min-w-0 sm:h-9")}
                >
                  {secretSaving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  Save secret
                </button>
              </div>
            </form>
          )}

          <div className="divide-y divide-border">
            {secretCatalogLoading && secretCatalogEntries.length === 0 ? (
              <ListSkeleton label="Loading secrets" rows={3} className="py-4" />
            ) : secretCatalogEntries.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No saved secrets yet.</p>
            ) : (
              secretCatalogEntries.map((entry) => (
                <div key={entry.secretRef} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="min-w-0 font-mono text-sm font-black [overflow-wrap:anywhere]">{entry.secretRef}</p>
                      <span
                        className={cn(
                          "px-2 py-0.5 text-xs font-bold capitalize",
                          COUNT_CHIP_MATERIAL_CLASS,
                          secretAccessChipClass(entry.access)
                        )}
                      >
                        {entry.access}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">Env {entry.envName || "-"}</span>
                      <span>Updated {entry.updatedAt ? relativeTime(entry.updatedAt) : "-"}</span>
                    </div>
                    {entry.description && (
                      <p className="mt-1 text-sm text-muted-foreground">{entry.description}</p>
                    )}
                  </div>
                  {canManageSecrets && <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:flex-wrap sm:items-center">
                    {confirmingSecretRef === entry.secretRef ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void deleteSecret(entry)}
                          disabled={deletingSecretRef === entry.secretRef}
                          className={actionClass({ variant: "danger", size: "sm" })}
                        >
                          {deletingSecretRef === entry.secretRef ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingSecretRef(null)}
                          disabled={deletingSecretRef === entry.secretRef}
                          className={actionClass({ variant: "secondary", size: "sm" })}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => openSecretEditor("edit", entry)}
                          disabled={secretSaving}
                          className={actionClass({ variant: "secondary", size: "sm" })}
                        >
                          <Pencil className="size-3.5" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSecretEditor(null);
                            setConfirmingSecretRef(entry.secretRef);
                          }}
                          disabled={secretSaving || Boolean(deletingSecretRef)}
                          className={actionClass({ variant: "danger", size: "sm" })}
                        >
                          <Trash2 className="size-3.5" />
                          Delete
                        </button>
                      </>
                    )}
                  </div>}
                </div>
              ))
            )}
          </div>
        </div>
      ) },
    // A deployment that meters nothing serves no Space billing, so it has no Billing section.
    ...(spacePlansAbsent(spaceBillingQuery.error) ? [] : [{
      key: SPACE_BILLING_SECTION, label: "Billing", icon: CreditCard, summary: spaceBillingSummary(spaceBillingQuery.data),
      content: <SpaceBillingSection userId={user.id} space={space} />,
    }]),
    { key: "desktop", label: "Desktop app", icon: Monitor, summary: desktopAvailable ? "Connected" : "Browser", content: (
        <div className="app-settings-section min-w-0">
          <div className="mb-4 flex items-center justify-between gap-3">
            <span
              className={cn(
                "rounded bg-muted px-2 py-1 text-xs font-bold",
                desktopAvailable ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {desktopAvailable ? "Connected" : "Browser"}
            </span>
          </div>
          <div className="space-y-2 text-sm">
            <DetailRow label="App version" value={desktopContext?.version || "-"} />
            <DetailRow
              label="Platform"
              value={desktopContext ? desktopContext.platform : "-"}
            />
            <DetailRow
              label="Daemon"
              value={desktopDaemonLabel(desktopDaemonStatus, desktopAvailable)}
            />
            <DetailRow
              label="Updates"
              value={desktopUpdateLabel(
                desktopUpdateStatus,
                desktopAvailable,
                desktopUpdateBridgeAvailable
              )}
            />
          </div>
          {desktopUpdateStatus?.percent !== undefined && desktopUpdateStatus.state === "downloading" && (
            <div className="mt-4 h-1.5 overflow-hidden rounded bg-muted">
              <div
                className="h-full rounded bg-primary"
                style={{ width: `${Math.max(0, Math.min(100, desktopUpdateStatus.percent))}%` }}
              />
            </div>
          )}
          {desktopAvailable && desktopUpdateStatus?.enabled && (
            <DesktopUpdateAction
              status={desktopUpdateStatus}
              checking={checkingDesktopUpdates}
              onCheck={onCheckDesktopUpdates}
              onInstall={onInstallDesktopUpdate}
            />
          )}
          <p className="mt-4 text-sm text-muted-foreground">
            {desktopDaemonStatus?.message || "Opening the desktop app starts the local daemon automatically."}
          </p>
          <div className="mt-4 grid grid-cols-1 gap-2 min-[360px]:grid-cols-3">
            <button
              onClick={onStartDesktopDaemon}
              disabled={!desktopAvailable || daemonRunning || daemonBusy}
              className={actionClass({ variant: "secondary", size: "lg" }, "min-w-0 sm:h-9 sm:px-3")}
            >
              <Radio className="size-4" />
              Start
            </button>
            <button
              onClick={onStopDesktopDaemon}
              disabled={!desktopAvailable || !daemonRunning}
              className={actionClass({ variant: "secondary", size: "lg" }, "min-w-0 sm:h-9 sm:px-3")}
            >
              <X className="size-4" />
              Stop
            </button>
            <button
              onClick={onRestartDesktopDaemon}
              disabled={!desktopAvailable || daemonBusy}
              className={actionClass({ variant: "secondary", size: "lg" }, "min-w-0 sm:h-9 sm:px-3")}
            >
              <RefreshCw className={cn("size-4", daemonBusy && "animate-spin")} />
              Restart
            </button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            {desktopUpdateDescription(
              desktopUpdateStatus,
              desktopAvailable,
              desktopUpdateBridgeAvailable
            )}
          </p>
        </div>
      ) },
    { key: "legal", label: "Legal and privacy", icon: Shield, summary: "Terms, privacy, cookies", content: (
        <div className="app-settings-section min-w-0">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="mt-1 text-sm text-muted-foreground">
                Review the terms that apply to xMatrix and how MadeByRobot handles information.
              </p>
            </div>
          </div>
          <div className="grid gap-2">
            <a
              href="/privacy"
              className="flex h-9 w-full items-center justify-between rounded border border-border bg-card px-3 text-sm font-bold hover:bg-muted"
            >
              Privacy Policy
              <ChevronRight className="size-4 text-muted-foreground" />
            </a>
            <a
              href="/terms"
              className="flex h-9 w-full items-center justify-between rounded border border-border bg-card px-3 text-sm font-bold hover:bg-muted"
            >
              Terms of Service
              <ChevronRight className="size-4 text-muted-foreground" />
            </a>
            <a
              href="/cookies"
              className="flex h-9 w-full items-center justify-between rounded border border-border bg-card px-3 text-sm font-bold hover:bg-muted"
            >
              Cookies and Local Storage
              <ChevronRight className="size-4 text-muted-foreground" />
            </a>
            <a
              href="/subprocessors"
              className="flex h-9 w-full items-center justify-between rounded border border-border bg-card px-3 text-sm font-bold hover:bg-muted"
            >
              Subprocessors
              <ChevronRight className="size-4 text-muted-foreground" />
            </a>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Privacy, access, correction, and deletion requests can be sent to{" "}
            <a className="font-medium text-foreground underline underline-offset-4" href="mailto:contact@madebyrobot.net?subject=xMatrix%20privacy%20request">
              contact@madebyrobot.net
            </a>
            .
          </p>
        </div>
      ) },
    { key: "session", label: "Session", icon: LogOut, summary: "Sign out of this browser", content: (
        <div className="app-settings-section min-w-0">
          <p className="mb-4 text-sm text-muted-foreground">Sign out of this browser session. CLI sessions remain separate.</p>
          <button
            onClick={onLogout}
            className={actionClass({ variant: "danger", size: "md" }, "w-full")}
          >
            <LogOut className="size-4" />
            Sign out
          </button>
        </div>
      ) },
  ];
  return <SectionedToolView title="Settings" sections={sections} />;
}

export type ManagementAgentPatch = {
  enabled?: boolean;
  sideEffectsEnabled?: boolean;
  /** Null restores the platform template. */
  prompt?: string | null;
  defaultChannelVisibility?: ManagementChannelVisibility;
};

export interface SpaceMemberActions {
  onDecideJoinRequest: (spaceId: string, requestId: string, approve: boolean) => Promise<void>;
  onCreateSpaceInviteCode: (
    spaceId: string,
    options: { maxUses: number | "unlimited"; expiresInHours?: number; requiresApproval: boolean }
  ) => Promise<{ token: string }>;
  onInviteSpaceMembers: (
    spaceId: string,
    emails: string[]
  ) => Promise<SpaceInviteResult>;
  onUpdateSpaceMemberRole: (
    spaceId: string,
    userId: string,
    role: SpaceInviteRole
  ) => Promise<SpaceMemberActionResult>;
  onUpdateSpaceManagementAgent: (
    spaceId: string,
    patch: ManagementAgentPatch
  ) => Promise<void>;
  onUpdateSpaceMemberPermissions: (
    spaceId: string,
    patch: Partial<SpaceMemberPermissions>
  ) => Promise<void>;
  onRemoveSpaceMember: (
    spaceId: string,
    userId: string
  ) => Promise<SpaceMemberActionResult>;
  onUpdateSpacePreferredLanguage: (spaceId: string, language: "zh" | "en" | "") => Promise<void>;
  onDeleteSpace: (spaceId: string) => Promise<{ purgeAfter: string }>;
  onRestoreSpace: (spaceId: string) => Promise<void>;
}


export function SpaceManagementAgentCard({
  space,
  canManage,
  setupHighlight,
  onUpdate,
  onDismissSetup,
}: {
  space: SerializedSpace;
  canManage: boolean;
  setupHighlight: boolean;
  onUpdate: (
    spaceId: string,
    patch: ManagementAgentPatch
  ) => Promise<void>;
  onDismissSetup: () => void;
}) {
  const config = space.managementAgent;
  const enabled = config?.enabled === true;
  const sideEffectsEnabled = config?.sideEffectsEnabled !== false;
  const savedPrompt = config?.prompt ?? "";
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const prompt = promptDraft ?? savedPrompt;
  const [pending, setPending] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const defaultReadMode = config?.defaultChannelVisibility || "management-visible";
  const needsSetup = canManage && !enabled;
  const promptChanged = promptDraft !== null && promptDraft !== savedPrompt;
  async function submit(patch: ManagementAgentPatch) {
    if (pending) return;
    setPending(true);
    setCardError(null);
    try {
      await onUpdate(space.id, patch);
      if (patch.prompt !== undefined) setPromptDraft(null);
      if (setupHighlight && patch.enabled) onDismissSetup();
    } catch (err) {
      setCardError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className={cn(
        "mt-4 border-t border-border/60 pt-4",
        needsSetup && "border-primary/40",
        setupHighlight && needsSetup && "border-l-2 border-l-primary pl-3"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-black">
            {needsSetup ? "Set up xMatrix" : "xMatrix assistant"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Where xMatrix runs when it answers <code>@xMatrix</code> and keeps Channel summaries current.
            Write a summon such as <code>@auto harness:codex</code>.
          </p>
        </div>
        <span
          className={cn(
            "app-status-chip shrink-0 px-3 py-1 text-xs font-bold",
            COUNT_CHIP_MATERIAL_CLASS
          )}
        >
          {enabled ? (sideEffectsEnabled ? "enabled" : "read-only") : needsSetup ? "not set up" : "off"}
        </span>
      </div>
      {canManage ? (
        <div className="mt-3 grid grid-cols-3 items-center gap-2 sm:flex sm:flex-wrap">
          <textarea
            value={prompt}
            disabled={pending}
            autoFocus={setupHighlight && needsSetup}
            onChange={(event) => setPromptDraft(event.target.value)}
            aria-label={`xMatrix prompt for ${space.name}`}
            placeholder="@auto harness:codex"
            rows={8}
            spellCheck={false}
            className="col-span-3 min-h-40 w-full rounded border border-border bg-card px-2 py-1.5 font-mono text-xs outline-none disabled:opacity-60"
          />
          <button
            type="button"
            disabled={pending || (enabled && !promptChanged)}
            onClick={() =>
              void submit({
                ...(enabled ? {} : { enabled: true }),
                ...(promptChanged ? { prompt: promptDraft!.trim() ? promptDraft : null } : {}),
              })
            }
            className={cn(
              "h-8 min-w-0 rounded border border-border bg-card px-2 text-xs font-bold hover:text-primary disabled:cursor-not-allowed disabled:opacity-60 sm:shrink-0 sm:px-3",
              !enabled && "col-span-3"
            )}
          >
            {pending ? "Saving…" : enabled ? "Save prompt" : "Enable"}
          </button>
          {config?.prompt !== undefined ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void submit({ prompt: null })}
              className={actionClass({ variant: "secondary", size: "sm" }, "min-w-0 sm:shrink-0 sm:px-3")}
              title="Use the platform template again"
            >
              Reset to template
            </button>
          ) : null}
          {enabled ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void submit({ sideEffectsEnabled: !sideEffectsEnabled })}
              className={actionClass({ variant: "secondary", size: "sm" }, "min-w-0 sm:shrink-0 sm:px-3")}
              title={
                sideEffectsEnabled
                  ? "Pause every management side effect while preserving read-only diagnosis and audit access"
                  : "Resume Hub-authorized management side effects"
              }
            >
              {sideEffectsEnabled ? "Pause actions" : "Resume actions"}
            </button>
          ) : null}
          {enabled ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => void submit({ enabled: false })}
              className={actionClass({ variant: "secondary", size: "sm" }, "min-w-0 sm:shrink-0 sm:px-3")}
            >
              Disable
            </button>
          ) : null}
          {enabled && !sideEffectsEnabled ? (
            <p className={noticeClass("attention", "col-span-3 w-full text-xs font-bold")}>
              The management fuse is active. xMatrix can still inspect events and audit records,
              but Hub rejects every side effect.
            </p>
          ) : null}
          <label className="col-span-3 flex min-w-0 flex-1 items-center gap-2 text-xs font-bold text-muted-foreground">
            Default
            <div className="min-w-0 flex-1">
              <GlassSelect
                value={defaultReadMode}
                disabled={pending}
                aria-label={`Management assistant default read mode for ${space.name}`}
                options={[
                  { value: "management-visible", label: "Read channels" },
                  { value: "metadata-only", label: "Activity only" },
                  { value: "excluded", label: "Off by default" },
                ]}
                onChange={(value) =>
                  void submit({
                    defaultChannelVisibility: value as ManagementChannelVisibility,
                  })
                }
                className="h-8 rounded bg-card px-2 text-xs font-bold text-foreground"
              />
            </div>
          </label>
          {setupHighlight && needsSetup ? (
            <button
              type="button"
              disabled={pending}
              onClick={onDismissSetup}
              className="h-8 shrink-0 rounded px-2 text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              Skip for now
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Only owners and admins can change this.
        </p>
      )}
      {cardError ? <p className="mt-2 text-xs text-destructive">{cardError}</p> : null}
    </div>
  );
}

export function TeamView({
  token,
  user,
  currentSpace,
  error,
  managementSetupSpaceId,
  joinRequestsBySpace,
  onDecideJoinRequest,
  onCreateSpaceInviteCode,
  onInviteSpaceMembers,
  onUpdateSpaceMemberRole,
  onRemoveSpaceMember,
  onUpdateSpaceManagementAgent,
  onUpdateSpaceMemberPermissions,
  onUpdateSpacePreferredLanguage,
  onDeleteSpace,
  onRestoreSpace,
  onDismissManagementSetup,
  spaces,
  creatingSpace,
  onCreateSpace,
  onSelectSpace,
}: {
  token?: string;
  user: { id: string; email: string; name?: string; avatarUrl?: string };
  currentSpace: SerializedSpace | null;
  error: string | null;
  managementSetupSpaceId: string | null;
  joinRequestsBySpace: Record<string, SpaceJoinRequest[]>;

  onDismissManagementSetup: () => void;
  spaces: SerializedSpace[];
  creatingSpace: boolean;
  onCreateSpace: (name: string) => Promise<SerializedSpace | undefined>;
  onSelectSpace: (spaceId: string) => void;
} & SpaceMemberActions) {
  const queryClient = useQueryClient();
  const teamSpaces = currentSpace ? [currentSpace] : [];
  const [inviteEmailsBySpace, setInviteEmailsBySpace] = useState<Record<string, string>>({});
  const [invitingSpaceId, setInvitingSpaceId] = useState<string | null>(null);
  const [inviteStatusBySpace, setInviteStatusBySpace] = useState<
    Record<string, { type: "success" | "error"; message: string }>
  >({});
  const [memberActionKey, setMemberActionKey] = useState<string | null>(null);
  const [memberStatusBySpace, setMemberStatusBySpace] = useState<
    Record<string, { type: "success" | "error"; message: string }>
  >({});
  const [permissionBusyBySpace, setPermissionBusyBySpace] = useState<Record<string, boolean>>({});
  const [permissionErrorBySpace, setPermissionErrorBySpace] = useState<Record<string, string>>({});

  const [codeApprovalBySpace, setCodeApprovalBySpace] = useState<Record<string, boolean>>({});
  const [codeUnlimitedBySpace, setCodeUnlimitedBySpace] = useState<Record<string, boolean>>({});
  const [codeBySpace, setCodeBySpace] = useState<Record<string, string>>({});
  const [codeErrorBySpace, setCodeErrorBySpace] = useState<Record<string, string>>({});
  const [creatingCodeSpaceId, setCreatingCodeSpaceId] = useState<string | null>(null);

  const joinDecisionMutation = useMutation({
    mutationKey: xmatrixQueryKeys.domain({ userId: user.id }, "space-join-decision"),
    mutationFn: (input: { spaceId: string; requestId: string; approve: boolean }) =>
      onDecideJoinRequest(input.spaceId, input.requestId, input.approve),
    onSuccess: (_result, input) => {
      queryClient.setQueryData<SpaceJoinRequest[]>(
        xmatrixQueryKeys.domain({ userId: user.id }, "space-join-requests", [input.spaceId]),
        (current = []) => current.filter((item) => item.id !== input.requestId),
      );
    },
  });
  const decidingRequestId = joinDecisionMutation.isPending
    ? joinDecisionMutation.variables?.requestId ?? null : null;

  async function decideJoinRequest(spaceId: string, request: SpaceJoinRequest, approve: boolean) {
    if (decidingRequestId) return;
    try {
      await joinDecisionMutation.mutateAsync({ spaceId, requestId: request.id, approve });
    } catch (error) {
      setCodeErrorBySpace((current) => ({
        ...current,
        [spaceId]: error instanceof Error ? error.message : "Failed to decide this request",
      }));
    }
  }

  /* The token is shown once and never again: the Hub keeps only its hash, so a
     code that is not copied now cannot be recovered later. */
  async function submitInviteCode(space: SerializedSpace) {
    if (creatingCodeSpaceId) return;
    setCreatingCodeSpaceId(space.id);
    setCodeErrorBySpace((current) => ({ ...current, [space.id]: "" }));
    try {
      const result = await onCreateSpaceInviteCode(space.id, {
        maxUses: codeUnlimitedBySpace[space.id] ? "unlimited" : 25,
        requiresApproval: codeApprovalBySpace[space.id] === true,
      });
      setCodeBySpace((current) => ({ ...current, [space.id]: result.token }));
    } catch (error) {
      setCodeErrorBySpace((current) => ({
        ...current,
        [space.id]: error instanceof Error ? error.message : "Failed to create invite code",
      }));
    } finally {
      setCreatingCodeSpaceId(null);
    }
  }

  async function submitInvite(space: SerializedSpace) {
    if (invitingSpaceId) return;
    const emails = parseInviteEmails(inviteEmailsBySpace[space.id] || "");
    if (emails.length === 0) {
      setInviteStatusBySpace((current) => ({
        ...current,
        [space.id]: { type: "error", message: "Enter at least one valid email." },
      }));
      return;
    }

    setInvitingSpaceId(space.id);
    setInviteStatusBySpace((current) => {
      const next = { ...current };
      delete next[space.id];
      return next;
    });
    try {
      const result = await onInviteSpaceMembers(space.id, emails);
      const sent = result.sent || [];
      const failed = result.failed || [];
      if (failed.length > 0) {
        setInviteStatusBySpace((current) => ({
          ...current,
          [space.id]: {
            type: "error",
            message: `Sent ${sent.length}, failed ${failed.length}.`,
          },
        }));
        return;
      }
      setInviteEmailsBySpace((current) => ({ ...current, [space.id]: "" }));
      setInviteStatusBySpace((current) => ({
        ...current,
        [space.id]: {
          type: "success",
          message: `Invite sent to ${sent.join(", ")}.`,
        },
      }));
    } catch (err) {
      setInviteStatusBySpace((current) => ({
        ...current,
        [space.id]: { type: "error", message: (err as Error).message },
      }));
    } finally {
      setInvitingSpaceId(null);
    }
  }

  async function performMemberAction(key: string, spaceId: string, operation: () => Promise<unknown>, message: string) {
    setMemberActionKey(key);
    setMemberStatusBySpace(current => {
      const next = { ...current }; delete next[spaceId]; return next;
    });
    try {
      await operation();
      setMemberStatusBySpace(current => ({ ...current, [spaceId]: { type: "success", message } }));
    } catch (err) {
      setMemberStatusBySpace(current => ({ ...current, [spaceId]: { type: "error", message: (err as Error).message } }));
    } finally { setMemberActionKey(null); }
  }

  async function updateMemberRole(space: SerializedSpace, userId: string, role: SpaceInviteRole) {
    await performMemberAction(`${space.id}:${userId}:role`, space.id,
      () => onUpdateSpaceMemberRole(space.id, userId, role), "Member role updated.");
  }

  async function removeMember(space: SerializedSpace, userId: string, label: string) {
    if (!window.confirm(`Remove ${label} from ${space.name}?`)) return;
    await performMemberAction(`${space.id}:${userId}:remove`, space.id,
      () => onRemoveSpaceMember(space.id, userId), "Member removed.");
  }

  async function updateMemberPermission(
    space: SerializedSpace,
    capability: keyof SpaceMemberPermissions,
    allowMembers: boolean,
  ) {
    if (permissionBusyBySpace[space.id]) return;
    setPermissionBusyBySpace((current) => ({ ...current, [space.id]: true }));
    setPermissionErrorBySpace((current) => ({ ...current, [space.id]: "" }));
    try {
      await onUpdateSpaceMemberPermissions(space.id, {
        [capability]: creationPolicyFromSwitch(allowMembers),
      });
    } catch (error) {
      setPermissionErrorBySpace((current) => ({
        ...current,
        [space.id]: error instanceof Error ? error.message : "Failed to update member permissions",
      }));
    } finally {
      setPermissionBusyBySpace((current) => ({ ...current, [space.id]: false }));
    }
  }

  // Team lists every workspace you belong to; the one you are in is tagged and managed beside the list.
  const currentContent = (
          <div className="app-team-view space-y-5">
      {currentSpace && ["owner", "admin"].includes(spaceRoleFor(currentSpace, user.id) || "") ? (
        <ChannelTransferQueue token={token} userId={user.id} spaceId={currentSpace.id} />
      ) : null}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4">
        <div className="space-y-4">
          <div className="space-y-4">

            <div className="divide-y divide-border/60 border-y border-border/60">
              {teamSpaces.map((space) => {
                const canManage = canInviteToSpace(space, user.id);
                const memberPermissions = effectiveSpaceMemberPermissions(space);
                const permissionBusy = permissionBusyBySpace[space.id] === true;
                return (
                <section key={space.id} className="py-5 first:pt-4 last:pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-black">{space.name}</p>
                    </div>
                    <span className={cn("shrink-0 px-2 py-1 text-xs font-bold text-primary", COUNT_CHIP_MATERIAL_CLASS)}>
                      {spaceRoleFor(space, user.id)}
                    </span>
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    {space.members.length} {space.members.length === 1 ? "member" : "members"}
                  </div>
                  <SpaceManagementAgentCard
                    space={space}
                    canManage={canManage}
                    setupHighlight={space.id === managementSetupSpaceId}
                    onUpdate={onUpdateSpaceManagementAgent}
                    onDismissSetup={onDismissManagementSetup}
                  />
                  {canManage ? (
                    <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:flex">
                      <span className="font-bold">Language / 语言</span>
                      <GlassSelect
                        value={spacePreferredLanguage(space) || ""}
                        aria-label={`Preferred language for ${space.name}`}
                        options={[
                          { value: "", label: "Auto" },
                          { value: "zh", label: "中文" },
                          { value: "en", label: "English" },
                        ]}
                        onChange={(value) =>
                          void onUpdateSpacePreferredLanguage(
                            space.id,
                            value as "zh" | "en" | ""
                          ).catch(() => undefined)
                        }
                        className="h-7 rounded bg-card px-2 text-xs font-bold"
                      />
                      <span className="col-span-2 sm:col-span-1">xMatrix speaks this language in this workspace.</span>
                    </div>
                  ) : null}
                  {canManage && token ? <SpaceOpenParticipation spaceId={space.id} token={token} /> : null}
                  <div className="mt-4 border-t border-border/60 pt-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-black">Member creation permissions</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          These controls affect new resources only. Existing Agents and Automations keep working.
                        </p>
                      </div>
                      {permissionBusy ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {([
                        ["agentCreation", "Allow members to add agents"],
                        ["automationCreation", "Allow members to create automations"],
                      ] as const).map(([capability, label]) => (
                        <label key={capability} className="flex items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={memberPermissions[capability] === "members"}
                            disabled={!canManage || permissionBusy}
                            onChange={(event) => void updateMemberPermission(space, capability, event.target.checked)}
                            className="mt-0.5 size-4 accent-primary"
                          />
                          <span>
                            <span className="block font-bold">{label}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {memberPermissions[capability] === "members"
                                ? "All Space members may create."
                                : "Only owners and admins may create."}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                    {!canManage ? (
                      <p className="mt-2 text-xs text-muted-foreground">Only owners and admins can change these permissions.</p>
                    ) : null}
                    {permissionErrorBySpace[space.id] ? (
                      <p className="mt-2 text-xs font-medium text-destructive">{permissionErrorBySpace[space.id]}</p>
                    ) : null}
                  </div>
                  <div className="mt-4 overflow-hidden rounded-md border border-border">
                    <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1.8fr)_140px_48px] gap-3 border-b border-border bg-muted/50 px-3 py-2 text-xs font-bold uppercase text-muted-foreground md:grid">
                      <span>Name</span>
                      <span>Email</span>
                      <span>Role</span>
                      <span className="text-right">Remove</span>
                    </div>
                    {space.members.map((member) => {
                      const memberLabel = member.name || member.email || shortId(member.userId);
                      const canEditMember = canManage && member.role !== "owner" && member.userId !== user.id;
                      const roleActionKey = `${space.id}:${member.userId}:role`;
                      const removeActionKey = `${space.id}:${member.userId}:remove`;
                      return (
                      <div
                        key={member.userId}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-3 py-3 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.8fr)_140px_48px] md:gap-3"
                      >
                        <div className="col-span-2 min-w-0 md:col-span-1">
                          <p className="truncate text-sm font-bold text-foreground">{memberLabel}</p>
                          <p className="truncate text-xs text-muted-foreground md:hidden">{member.email || member.userId}</p>
                        </div>
                        <div className="hidden min-w-0 md:block">
                          <p className="truncate text-sm text-muted-foreground">{member.email || member.userId}</p>
                        </div>
                        {member.role === "owner" ? (
                          <span
                            className={cn(
                              "app-status-chip inline-flex h-8 w-fit items-center px-3 text-xs font-bold",
                              COUNT_CHIP_MATERIAL_CLASS
                            )}
                          >
                            owner
                          </span>
                        ) : (
                          <GlassSelect
                            value={member.role}
                            disabled={!canEditMember || memberActionKey === roleActionKey}
                            options={[
                              { value: "admin", label: "admin" },
                              { value: "member", label: "member" },
                              { value: "viewer", label: "viewer" },
                            ]}
                            onChange={(value) =>
                              void updateMemberRole(space, member.userId, value as SpaceInviteRole)
                            }
                            aria-label={`Role for ${memberLabel}`}
                            className="h-8 rounded bg-card px-2 text-xs font-bold disabled:cursor-not-allowed"
                          />
                        )}
                        <div className="flex justify-end">
                          {canEditMember ? (
                          <button
                            type="button"
                            onClick={() => void removeMember(space, member.userId, memberLabel)}
                            disabled={memberActionKey === removeActionKey}
                            title={`Remove ${memberLabel}`}
                            className={actionClass({ variant: "secondary", size: "icon" }, "shrink-0")}
                          >
                            {memberActionKey === removeActionKey ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </button>
                          ) : (
                            <span className="flex size-8 items-center justify-center text-xs font-bold text-muted-foreground">-</span>
                          )}
                        </div>
                      </div>
                      );
                    })}
                  </div>
                  {memberStatusBySpace[space.id] && (
                    <p
                      className={cn(
                        "mt-3 text-xs font-medium",
                        memberStatusBySpace[space.id].type === "success"
                          ? "text-foreground"
                          : "text-destructive"
                      )}
                    >
                      {memberStatusBySpace[space.id].message}
                    </p>
                  )}
                  {canManage && (
                    <div className="mt-4 space-y-2">
                      <form
                        className="flex flex-col gap-2 sm:flex-row"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void submitInvite(space);
                        }}
                      >
                        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
                          <Mail className="size-4 shrink-0 text-muted-foreground" />
                          <input
                            value={inviteEmailsBySpace[space.id] || ""}
                            onChange={(event) =>
                              setInviteEmailsBySpace((current) => ({
                                ...current,
                                [space.id]: event.target.value,
                              }))
                            }
                            placeholder="Invite by email"
                            aria-label={`Invite emails to ${space.name}`}
                            className="min-w-0 flex-1 bg-transparent outline-none"
                          />
                        </label>
                        <button
                          type="submit"
                          disabled={invitingSpaceId === space.id}
                          className={actionClass({ variant: "primary", size: "md" }, "shrink-0")}
                        >
                          {invitingSpaceId === space.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Send className="size-4" />
                          )}
                          Invite
                        </button>
                      </form>
                      {inviteStatusBySpace[space.id] && (
                        <p
                          className={cn(
                            "text-xs font-medium",
                            inviteStatusBySpace[space.id].type === "success"
                              ? "text-foreground"
                              : "text-destructive"
                          )}
                        >
                          {inviteStatusBySpace[space.id].message}
                        </p>
                      )}
                      {(joinRequestsBySpace[space.id] || []).length > 0 && (
                        <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                          <p className="text-xs font-bold text-muted-foreground">
                            Waiting for you ({(joinRequestsBySpace[space.id] || []).length})
                          </p>
                          {(joinRequestsBySpace[space.id] || []).map((request) => (
                            <div
                              key={request.id}
                              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-2 text-xs"
                            >
                              <span className="min-w-0 flex-1 truncate font-medium">
                                {request.name || request.email || request.userId}
                              </span>
                              <button
                                type="button"
                                disabled={decidingRequestId === request.id}
                                onClick={() => void decideJoinRequest(space.id, request, true)}
                                className={actionClass({ variant: "primary", size: "sm" })}
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={decidingRequestId === request.id}
                                onClick={() => void decideJoinRequest(space.id, request, false)}
                                className={actionClass({ variant: "secondary", size: "sm" })}
                              >
                                Decline
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                        <p className="text-xs font-bold text-muted-foreground">
                          Or share a link
                        </p>
                        <div className="flex flex-wrap items-center gap-3 text-xs">
                          <label className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={codeApprovalBySpace[space.id] === true}
                              onChange={(event) =>
                                setCodeApprovalBySpace((current) => ({
                                  ...current,
                                  [space.id]: event.target.checked,
                                }))
                              }
                            />
                            Require my approval
                          </label>
                          <label className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={codeUnlimitedBySpace[space.id] === true}
                              onChange={(event) =>
                                setCodeUnlimitedBySpace((current) => ({
                                  ...current,
                                  [space.id]: event.target.checked,
                                }))
                              }
                            />
                            Unlimited uses
                          </label>
                          <button
                            type="button"
                            disabled={creatingCodeSpaceId === space.id}
                            onClick={() => void submitInviteCode(space)}
                            className={actionClass({ variant: "secondary", size: "md" })}
                          >
                            {creatingCodeSpaceId === space.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <LinkIcon className="size-3.5" />
                            )}
                            Create link
                          </button>
                        </div>
                        {codeUnlimitedBySpace[space.id] && (
                          <p className={noticeClass("attention", "text-[11px]")}>
                            An unlimited link never stops working — anyone it reaches can join.
                          </p>
                        )}
                        {codeBySpace[space.id] && (
                          <div className="flex flex-col gap-1">
                            <code className="select-all break-all rounded bg-muted px-2 py-1.5 text-[11px]">
                              {`${typeof window === "undefined" ? "" : window.location.origin}/spaces/invite/${codeBySpace[space.id]}`}
                            </code>
                            <p className={noticeClass("attention", "text-[11px] font-medium")}>
                              Copy it now — this link is shown once and cannot be retrieved again.
                            </p>
                          </div>
                        )}
                        {codeErrorBySpace[space.id] && (
                          <p className="text-xs font-medium text-destructive">{codeErrorBySpace[space.id]}</p>
                        )}
                      </div>
                    </div>
                  )}
                  {spaceRoleFor(space, user.id) === "owner" ? (
                    <SpaceDangerZone space={space} userId={user.id} onDeleteSpace={onDeleteSpace} />
                  ) : null}
                </section>
                );
              })}

              {teamSpaces.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
                  Open a Space to manage its members and invitations.
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
          </div>
  );
  return (
    <SectionedToolView title="Team" defaultKey={currentSpace?.id} sections={[
      ...spaces.map((space): ToolSection => {
        const current = space.id === currentSpace?.id;
        return {
          key: space.id,
          label: space.name,
          icon: Building,
          end: current ? "Current" : undefined,
          summary: spaceSummary(space, user.id, current ? (joinRequestsBySpace[space.id] ?? []).length : 0),
          description: current
            ? `Members, invitations, and access for ${space.name}.`
            : "Switch to this workspace to manage it.",
          content: current ? currentContent : (
            <TeamOtherSpace space={space} userId={user.id} onSelectSpace={onSelectSpace} onDeleteSpace={onDeleteSpace} />
          ),
        };
      }),
      { key: "new", label: "New workspace", icon: PlusCircle, create: true,
        summary: "Create a workspace or restore one",
        description: "Create a workspace, or restore one you deleted in the last 7 days.",
        content: (
          <TeamNewSpace
            token={token}
            userId={user.id}
            creatingSpace={creatingSpace}
            onCreateSpace={onCreateSpace}
            onRestoreSpace={onRestoreSpace}
          />
        ) },
    ]} />
  );
}

export function AutomationExpressionGuidance({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        compact ? "mt-1 space-y-0.5 text-[11px]" : "mt-2 space-y-1 text-xs",
        "text-muted-foreground"
      )}
    >
      <p>
        <strong className="text-foreground">Agent:</strong> @auto repo:&lt;owner/repo&gt; addresses an Agent. The resume interval controls when the Automation runs again. Use pwd:&quot;&lt;registered-path&gt;&quot; for a registered directory.
      </p>
      <p>
        <strong className="text-foreground">Existing live Agent:</strong> @agent:N addresses that Channel instance. It must be online; everyone else receives context only.
      </p>
      <p>
        <strong className="text-foreground">No Agent mention:</strong> only the Channel expression or App action is posted.
      </p>
      <p>
        <strong className="text-foreground">Editing keeps its creator:</strong> changing this form never changes the captured Human or Agent author.
      </p>
    </div>
  );
}

export function ErrorPanel({ title, error }: { title: string; error: string }) {
  return (
    <LiquidGlassCard className="border border-destructive/30 p-6">
      <h2 className="font-black text-destructive">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{error}</p>
    </LiquidGlassCard>
  );
}

export function EmptyToolState({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <LiquidGlassCard className="app-empty-state flex min-h-[360px] flex-col items-center justify-center border px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-lg bg-muted">
        <Icon className="size-7 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-xl font-black">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
    </LiquidGlassCard>
  );
}

export function DetailBlock({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <WoodPanel as="section" className="app-detail-plank p-4">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-black">{title}</h3>
        {action}
      </div>
      {children}
    </WoodPanel>
  );
}

/* min-w-0 keeps the row from inflating its grid track: a nowrap value (a machine
   ID, a long host name) would otherwise set the column's automatic minimum size
   and push every sibling row past the card, which overflow-x: hidden then clips
   away on phones. The value wraps instead of truncating so it stays readable
   where there is no hover title. */
export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 py-1">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium capitalize [overflow-wrap:anywhere]">{value}</span>
    </div>
  );
}

/** A component's version, marked when it is older than this web/hub release. */
export function MachineVersionValue({ version, className }: { version?: string; className?: string }) {
  const status = releaseVersionStatus(version);
  return (
    <span className={cn("flex min-h-5 min-w-0 flex-wrap items-center gap-1.5", className)}>
      <span className="min-w-0 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
        {version ? formatVersion(version) : "unknown"}
      </span>
      {status === "outdated" && (
        <span
          className={statusChipClass("attention", "inline-flex h-5 shrink-0 items-center gap-1 px-1.5")}
          title={`This component is older than web/hub ${formatVersion(XMATRIX_RELEASE_VERSION)}.`}
        >
          <AlertTriangle className="size-3.5" />
          Update
        </span>
      )}
    </span>
  );
}

export type FetchedChannelCatalog = {
  channels: SerializedChannel[];
  catalogSync?: ChannelCatalogSyncMetadata;
  attentionSnapshot?: ChannelAttentionSnapshot;
};

function parsedChannelCatalogSync(value: unknown): ChannelCatalogSyncMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sync = value as Partial<ChannelCatalogSyncMetadata>;
  if (sync.protocolVersion !== 1 || typeof sync.token !== "string" || !sync.token ||
      sync.token.length > 8_192 ||
      typeof sync.complete !== "boolean" || !Array.isArray(sync.replacedSpaceIds) ||
      sync.replacedSpaceIds.length > 96 || !Array.isArray(sync.removedSpaceIds) ||
      sync.removedSpaceIds.length > 96 ||
      sync.replacedSpaceIds.some((id) => typeof id !== "string" || !id || id.length > 180) ||
      sync.removedSpaceIds.some((id) => typeof id !== "string" || !id || id.length > 180)) {
    return undefined;
  }
  return sync as ChannelCatalogSyncMetadata;
}

function parsedChannelAttentionSnapshot(value: unknown): ChannelAttentionSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<ChannelAttentionSnapshot>;
  if (snapshot.protocolVersion !== 1 || !Array.isArray(snapshot.spaces) ||
      snapshot.spaces.length > 96 || snapshot.spaces.some((space) =>
        !space || typeof space.spaceId !== "string" || !space.spaceId ||
        space.spaceId.length > 180 || typeof space.complete !== "boolean" ||
        !Array.isArray(space.summaries) || space.summaries.length > 1_000 ||
        space.summaries.some((summary) => !isChannelAttentionSummary(summary)))) {
    return undefined;
  }
  return snapshot as ChannelAttentionSnapshot;
}

export async function fetchChannelCatalog(
  token: string,
  options: { spaceId?: string; catalogSyncToken?: string } = {}
): Promise<FetchedChannelCatalog> {
  const params = new URLSearchParams();
  if (options.spaceId) params.set("spaceId", options.spaceId);
  if (options.catalogSyncToken) params.set("catalogSyncToken", options.catalogSyncToken);
  const query = params.toString();
  const route = query ? `${WEB_PROXY_ROUTES.channels}?${query}` : WEB_PROXY_ROUTES.channels;
  const sequenceSignal = AbortSignal.timeout(CHANNEL_CATALOG_FETCH_TOTAL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await runWorkspaceFetchWithRetry(() =>
      fetch(route, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: workspaceAttemptSignal(sequenceSignal),
      }),
      { signal: sequenceSignal },
    );
  } catch (error) {
    if (sequenceSignal.aborted) throw new Error("Channel list request timed out", { cause: error });
    throw error;
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || "Failed to load channels");
  }

  const data = (await res.json()) as {
    channels?: SerializedChannel[];
    catalogSync?: unknown;
    attentionSnapshot?: unknown;
  };
  const catalogSync = parsedChannelCatalogSync(data.catalogSync);
  const attentionSnapshot = parsedChannelAttentionSnapshot(data.attentionSnapshot);
  if (data.catalogSync !== undefined && !catalogSync) {
    throw new Error("Channel catalog sync metadata is invalid");
  }
  if (data.attentionSnapshot !== undefined && !attentionSnapshot) {
    throw new Error("Channel attention snapshot is invalid");
  }
  return {
    channels: sortChannels(data.channels || []),
    ...(catalogSync ? { catalogSync } : {}),
    ...(attentionSnapshot ? { attentionSnapshot } : {}),
  };
}

export async function fetchChannels(
  token: string,
  options: { spaceId?: string } = {}
): Promise<SerializedChannel[]> {
  return (await fetchChannelCatalog(token, options)).channels;
}

export async function fetchEvents(
  token: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ObservabilityEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const data = await xmatrixApiRequest<{ events?: ObservabilityEvent[] }>({
    url: `${WEB_PROXY_ROUTES.observable_events}?${params.toString()}`,
    token,
    signal,
  });
  return data.events || [];
}

export function mergeObservabilityEvents(
  current: ObservabilityEvent[],
  incoming: ObservabilityEvent[],
  limit: number
): ObservabilityEvent[] {
  const byId = new Map<string, ObservabilityEvent>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return Array.from(byId.values())
    .sort((left, right) => {
      const byTime = timestampMs(right.timestamp) - timestampMs(left.timestamp);
      return byTime || right.id.localeCompare(left.id);
    })
    .slice(0, limit);
}

export async function fetchMachineDaemons(
  token: string,
  signal?: AbortSignal,
): Promise<SerializedMachineDaemon[]> {
  const data = await xmatrixApiRequest<{ daemons?: SerializedMachineDaemon[] }>({
    url: WEB_PROXY_ROUTES.machine_daemons,
    token,
    signal,
  });
  return data.daemons || [];
}

/** Renames one of the signed-in owner's Machines; the name changes no key. */
export async function renameMachine(token: string, machineId: string, name: string, create = false): Promise<string> {
  const data = await xmatrixApiRequest<{ name?: string }>({
    url: WEB_PROXY_ROUTES.machine_name(machineId), token, method: create ? "POST" : "PUT", body: { name },
  });
  return data.name || name;
}

/** Whether automatic assignment may place work on one of the owner's Machines. */
export async function setMachineAutoAssign(token: string, machineId: string, autoAssign: boolean): Promise<boolean> {
  const data = await xmatrixApiRequest<{ autoAssign?: boolean }>({
    url: WEB_PROXY_ROUTES.machine_auto_assign(machineId), token, method: "PUT", body: { autoAssign },
  });
  return data.autoAssign ?? autoAssign;
}

/**
 * Removes one of the signed-in owner's Machines, in any state: its running
 * agents stop and it leaves every list until `xmatrix login` on it adds it back.
 */
export async function removeMachine(token: string, machineId: string): Promise<void> {
  await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.machine(machineId), token, method: "DELETE" });
}

export async function fetchSpaces(token: string, signal?: AbortSignal): Promise<SerializedSpace[]> {
  const data = await xmatrixApiRequest<{ spaces?: SerializedSpace[] }>({
    url: WEB_PROXY_ROUTES.spaces, token, signal,
  });
  return sortSpaces(data.spaces || []);
}

export async function fetchProjects(
  token: string,
  signal?: AbortSignal,
): Promise<SerializedWorkspace[]> {
  const data = await xmatrixApiRequest<{ workspaces?: SerializedWorkspace[] }>({
    url: WEB_PROXY_ROUTES.workspaces, token, signal,
  });
  return sortProjects(data.workspaces || []);
}

export async function fetchAutomations(
  token: string,
  options: { spaceId?: string; signal?: AbortSignal } = {},
): Promise<SerializedAutomationCatalog> {
  const params = new URLSearchParams();
  if (options.spaceId) params.set("spaceId", options.spaceId);
  const query = params.toString();
  const data = await xmatrixApiRequest<Partial<SerializedAutomationCatalog>>({
    url: query ? `${WEB_PROXY_ROUTES.automations}?${query}` : WEB_PROXY_ROUTES.automations,
    token,
    signal: options.signal,
  });
  return {
    // A record from an older Hub may lack a name; every view sorts and shows by it.
    automations: sortAutomations((data.automations || []).map((automation) =>
      typeof automation.name === "string" && automation.name.trim()
        ? automation : { ...automation, name: automation.expression?.text?.split("\n")[0]?.trim().slice(0, 80) || "Automation" })),
    executionEnabled: data.executionEnabled === true,
    agentManagementEnabled: data.agentManagementEnabled === true,
  };
}

export function automationExpressionFromText(text: string): AutomationExpressionInput {
  return { kind: "text", language: "natural-language", text };
}

export async function patchAutomation(
  token: string,
  automationId: string,
  input: AutomationUpdateRequest
): Promise<SerializedAutomation> {
  const res = await fetch(WEB_PROXY_ROUTES.automation(automationId), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  const payload = (await res.json().catch(() => ({}))) as {
    automation?: SerializedAutomation;
    error?: string;
  };
  if (!res.ok || !payload.automation) {
    throw new Error(payload.error || "Failed to update Automation");
  }
  return payload.automation;
}

export async function setAutomationPaused(
  token: string,
  automation: SerializedAutomation,
  paused: boolean
): Promise<SerializedAutomation> {
  const route = paused
    ? WEB_PROXY_ROUTES.automation_pause(automation.id)
    : WEB_PROXY_ROUTES.automation_resume(automation.id);
  const res = await fetch(route, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: automation.version }),
    cache: "no-store",
  });
  const payload = (await res.json().catch(() => ({}))) as { automation?: SerializedAutomation; error?: string };
  if (!res.ok || !payload.automation) throw new Error(payload.error || "Failed to change Automation state");
  return payload.automation;
}

export async function removeAutomation(token: string, automation: SerializedAutomation): Promise<void> {
  const res = await fetch(WEB_PROXY_ROUTES.automation(automation.id), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: automation.version }),
    cache: "no-store",
  });
  await requireResponseOk(res, "Failed to delete Automation", 404);
}

export async function registerWorkspace(
  token: string,
  candidate: DesktopWorkspaceCandidate
): Promise<SerializedWorkspace> {
  const res = await fetch(WEB_PROXY_ROUTES.workspaces, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      machineId: candidate.machineId,
      hostname: candidate.hostname,
      canonicalCwd: candidate.canonicalCwd,
      displayName: candidate.displayName,
      repoRoot: candidate.repoRoot,
      gitRemote: candidate.gitRemote,
      gitBranch: candidate.gitBranch,
    }),
    cache: "no-store",
  });

  const payload = (await res.json().catch(() => ({}))) as {
    workspace?: SerializedWorkspace;
    error?: string;
  };
  if (!res.ok || !payload.workspace) {
    throw new Error(payload.error || "Failed to register workspace");
  }
  return payload.workspace;
}

export async function deleteWorkspace(token: string, workspace: SerializedWorkspace): Promise<void> {
  const res = await fetch(WEB_PROXY_ROUTES.workspaces, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ machineId: workspace.machineId, canonicalCwd: workspace.canonicalCwd }),
    cache: "no-store",
  });
  await requireResponseOk(res, "Failed to remove workspace", 404);
}

export type ChannelHistoryPage = {
  historyHeadSequence?: number;
  messages: ChannelMessage[];
  hasMore: boolean;
  contentRevision?: number;
};

/** A read on a connection the OS dropped (iOS resume) must fail and retry, not hang. */
const CHANNEL_HISTORY_FETCH_TIMEOUT_MS = 20_000;

export async function fetchChannelHistory(
  token: string,
  channelId: string,
  options: {
    limit: number;
    before?: string;
    beforeSequence?: number;
    afterSequence?: number;
    signal?: AbortSignal;
  }
): Promise<ChannelHistoryPage> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.beforeSequence !== undefined) {
    params.set("beforeSequence", String(options.beforeSequence));
  }
  if (options.before) params.set("before", options.before);
  if (options.afterSequence !== undefined) {
    params.set("afterSequence", String(options.afterSequence));
  }
  const res = await fetch(`${WEB_PROXY_ROUTES.channel_history(channelId)}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(CHANNEL_HISTORY_FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(CHANNEL_HISTORY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new Error(payload.error || "Failed to load channel history");
  }
  const data = (await res.json()) as {
    messages?: ChannelMessage[];
    hasMore?: unknown;
    contentAuthority?: unknown;
    historyHeadSequence?: unknown;
  };
  if (typeof data.hasMore !== "boolean") {
    throw new Error("Channel history response is missing pagination coverage");
  }
  const contentRevision = parseChannelContentRevision(data.contentAuthority);
  noteChannelContentRevision(channelId, contentRevision);
  return {
    messages: filterHistoryForChannel(
      channelId,
      (data.messages || [])
        .filter(isValidChannelMessage)
        .map(normalizeChannelMessageAttachments),
    ),
    hasMore: data.hasMore,
    contentRevision,
    ...(typeof data.historyHeadSequence === "number" &&
      Number.isSafeInteger(data.historyHeadSequence) && data.historyHeadSequence >= 0
      ? { historyHeadSequence: data.historyHeadSequence } : {}),
  };
}

/**
 * Authority online history returns content-addressed attachment metadata without a
 * presentation `kind`. Local replica rows already set it; normalize so the
 * timeline can hydrate image/video bodies instead of spinning forever.
 */
export function normalizeChannelMessageAttachments(
  entry: ChannelMessage,
): ChannelMessage {
  let changed = false;
  const attachments = entry.attachments?.map((attachment) => {
    const kind = presentationAttachmentKind(attachment);
    if (kind === attachment.kind) return attachment;
    changed = true;
    return { ...attachment, kind };
  });
  const replies = entry.thread?.replies.map((reply) => {
    const normalized = normalizeChannelMessageAttachments(reply);
    if (normalized !== reply) changed = true;
    return normalized;
  });
  return changed ? {
    ...entry,
    ...(attachments ? { attachments } : {}),
    ...(entry.thread && replies ? { thread: { ...entry.thread, replies } } : {}),
  } : entry;
}

export async function syncChannelReadCursor(
  token: string,
  channelId: string,
  sequence: number
): Promise<ChannelReadStateUpdate | undefined> {
  const res = await fetch(WEB_PROXY_ROUTES.channel_read(channelId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sequence }),
    cache: "no-store",
  });

  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => ({}))) as {
    attention?: unknown;
    readSequence?: unknown;
  };
  const attention = isChannelAttentionSummary(data.attention) ? data.attention : undefined;
  const readSequence = validChannelReadSequence(data.readSequence);
  return attention || readSequence !== undefined ? { attention, readSequence } : undefined;
}

export async function reactToChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string
): Promise<ChannelMessage> {
  const res = await fetch(WEB_PROXY_ROUTES.channel_message_reactions(channelId, messageId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ emoji }),
    cache: "no-store",
  });

  return requireMessageResponse(res, "Failed to update reaction");
}

export async function updateChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
  body: string
): Promise<ChannelMessage> {
  const res = await fetch(WEB_PROXY_ROUTES.channel_message(channelId, messageId), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body }),
    cache: "no-store",
  });

  return requireMessageResponse(res, "Failed to edit message");
}

export async function recallChannelMessage(
  token: string,
  channelId: string,
  messageId: string
): Promise<ChannelMessage> {
  const res = await fetch(WEB_PROXY_ROUTES.channel_message(channelId, messageId), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return requireMessageResponse(res, "Failed to recall message");
}

export function replaceChannel(channels: SerializedChannel[], channel: SerializedChannel): SerializedChannel[] {
  const index = channels.findIndex((current) => current.id === channel.id);
  const merged = mergeChannelListHydratedFields(index >= 0 ? channels[index] : undefined, channel);
  if (index < 0) return sortChannels([...channels, merged]);
  const next = channels.slice();
  next[index] = merged;
  // Most replacements (presence, read state, topic) leave a Channel where it
  // sorts; re-sorting a thousand Channels per realtime frame is what costs.
  const before = next[index - 1];
  const after = next[index + 1];
  const stillSorted = (!before || compareChannelsForSidebar(before, merged) <= 0) &&
    (!after || compareChannelsForSidebar(merged, after) <= 0);
  return stillSorted ? next : sortChannels(next);
}

export function mergeChannelListSnapshot(
  current: SerializedChannel[],
  incoming: SerializedChannel[],
): SerializedChannel[] {
  const currentById = new Map(current.map((channel) => [channel.id, channel]));
  return sortChannels(incoming.map((channel) =>
    mergeChannelListHydratedFields(
      currentById.get(channel.id),
      channel,
      "authoritative",
    )
  ));
}

export function mergeChannelListHydratedFields(
  prior: SerializedChannel | undefined,
  channel: SerializedChannel,
  viewerStateAuthority: ChannelViewerStateAuthority = "partial",
): SerializedChannel {
  if (!prior) return channel;
  /* partial and realtime payloads omit list-hydrated fields — keep what we knew */
  return {
    ...channel,
    messageCount: channel.messageCount ?? prior.messageCount,
    historyHeadSequence: channel.historyHeadSequence ?? prior.historyHeadSequence,
    ...mergeChannelViewerState(prior, channel, viewerStateAuthority),
    // Member read cursors only ever advance, so a payload that omits them (or
    // arrives behind a live cursor push) must not roll mention read state back.
    memberReadSequences: mergeChannelMemberReadSequences(
      prior.memberReadSequences,
      channel.memberReadSequences
    ),
    // A catalog snapshot can land after a live message push; the newer message
    // is the conversation's last one whichever payload carried it.
    lastMessage: !channel.lastMessage ||
      (prior.lastMessage &&
        timestampMs(prior.lastMessage.sentAt) > timestampMs(channel.lastMessage.sentAt))
      ? prior.lastMessage ?? channel.lastMessage
      : channel.lastMessage,
    // channel_updated can briefly re-serialize token-only usage; keep
    // subscription quota meters from the previous snapshot until hub
    // reports a real quota update again.
    memberPresence: mergeChannelMemberPresencePreferringQuotas(
      prior.memberPresence,
      channel.memberPresence
    ),
  };
}

export function mergeChannelMemberReadSequences(
  prior: SerializedChannel["memberReadSequences"] | undefined,
  next: SerializedChannel["memberReadSequences"] | undefined
): SerializedChannel["memberReadSequences"] | undefined {
  if (!next) return prior;
  if (!prior) return next;
  const merged: NonNullable<SerializedChannel["memberReadSequences"]> = { ...prior };
  for (const [subjectId, sequence] of Object.entries(next)) {
    const previous = merged[subjectId];
    if (previous === undefined || sequence > previous) merged[subjectId] = sequence;
  }
  return merged;
}

export function mergeChannelMemberPresencePreferringQuotas(
  prior: SerializedChannel["memberPresence"] | undefined,
  next: SerializedChannel["memberPresence"] | undefined
): SerializedChannel["memberPresence"] | undefined {
  if (!next) return prior;
  if (!prior) return next;
  const merged: NonNullable<SerializedChannel["memberPresence"]> = { ...next };
  for (const [memberId, nextPresence] of Object.entries(next)) {
    const priorPresence = prior[memberId];
    if (!priorPresence || nextPresence.kind !== "agent" || priorPresence.kind !== "agent") {
      continue;
    }
    const priorInstances = priorPresence.instances || [];
    const priorInstancesById = new Map(priorInstances.map((instance) => [instance.id, instance]));
    // channelInstanceId is the stable per-channel birth slot. Reborns change
    // global instance id but must keep the original birth connectedAt.
    const priorInstancesByChannelId = new Map(
      priorInstances
        .filter((instance) => instance.channelInstanceId)
        .map((instance) => [instance.channelInstanceId!, instance])
    );
    const nextInstances = (nextPresence.instances || []).map((instance) => {
      const previous =
        priorInstancesById.get(instance.id) ||
        (instance.channelInstanceId
          ? priorInstancesByChannelId.get(instance.channelInstanceId)
          : undefined);
      return previous
        ? mergeAgentInstancePresence(previous, instance)
        : instance;
    });
    merged[memberId] = {
      ...nextPresence,
      usage: mergeLlmUsagePreferringQuotas(priorPresence.usage, nextPresence.usage),
      instances: nextInstances.length > 0 ? nextInstances : nextPresence.instances,
    };
  }
  return merged;
}

export function patchChannelsAgentPresenceFromAgent(
  channels: SerializedChannel[],
  agent: SerializedAgent
): SerializedChannel[] {
  if (!agent.id) return channels;
  let changed = false;
  const next = channels.map((channel) => {
    const patched = patchChannelAgentPresenceFromAgent(channel, agent);
    if (patched !== channel) changed = true;
    return patched;
  });
  return changed ? next : channels;
}

export function patchChannelAgentPresenceFromAgent(
  channel: SerializedChannel,
  agent: SerializedAgent
): SerializedChannel {
  return patchChannelInstancesById(patchChannelAgentMemberFromAgent(channel, agent), agent);
}

/**
 * Catalog snapshots key each Instance by its own id, while live frames name
 * the socket's principal Agent, so one Instance can sit under a member the
 * frame does not name. An Instance id is globally unique: whichever member
 * holds it hears its report.
 */
export function patchChannelInstancesById(
  channel: SerializedChannel,
  agent: SerializedAgent
): SerializedChannel {
  const updatesById = new Map((agent.instances || []).map((instance) => [instance.id, instance]));
  if (updatesById.size === 0 || !channel.memberPresence) return channel;
  let next = channel;
  for (const [member, presence] of Object.entries(channel.memberPresence)) {
    if (member === agent.id || presence.kind !== "agent" || !presence.instances?.length) continue;
    let changed = false;
    const instances = presence.instances.map((instance) => {
      const update = updatesById.get(instance.id);
      if (!update) return instance;
      const merged = mergeAgentInstancePresence(instance, update);
      if (merged !== instance) changed = true;
      return merged;
    });
    if (changed) next = replaceChannelMemberPresence(next, member, { ...presence, instances });
  }
  return next;
}

function patchChannelAgentMemberFromAgent(
  channel: SerializedChannel,
  agent: SerializedAgent
): SerializedChannel {
  const presence = channel.memberPresence?.[agent.id];
  if (!presence || presence.kind !== "agent") return channel;

  const agentInstances = agent.instances || [];
  const agentInstancesById = new Map(agentInstances.map((instance) => [instance.id, instance]));
  // channelInstanceId is a per-channel slot ordinal (sibling threads all count
  // from 1), so slot fallback may only match updates that declare this exact
  // channel; unscoped updates merge by global instance id alone.
  const agentInstancesByChannelId = new Map(
    agentInstances
      .filter((instance) => instance.channelInstanceId && instance.channelId === channel.id)
      .map((instance) => [instance.channelInstanceId!, instance])
  );
  const priorInstances = presence.instances || [];
  let instanceChanged = false;
  // enhanced_presence often omits instances (workspace-wide broadcast). Still
  // push agent-level usage onto every known channel instance so quota chips stay live.
  const nextInstances = priorInstances.map((instance) => {
    const update =
      agentInstancesById.get(instance.id) ||
      (instance.channelInstanceId ? agentInstancesByChannelId.get(instance.channelInstanceId) : undefined);
    if (update) {
      // Receiving a frame is not the same as being told something new. Marking
      // the instance changed on arrival alone made the no-op short circuit
      // below unreachable for every frame that carried instances.
      const merged = mergeAgentInstancePresence(instance, update);
      if (merged !== instance) instanceChanged = true;
      return merged;
    }
    if (agent.usage) {
      const mergedUsage = mergeAccountLevelLlmUsage(instance.usage, agent.usage);
      if (mergedUsage !== instance.usage) {
        instanceChanged = true;
        return { ...instance, usage: mergedUsage };
      }
    }
    return instance;
  });

  const nextUsage = mergeAccountLevelLlmUsage(presence.usage, agent.usage);
  const usageChanged = nextUsage !== presence.usage;
  if (!instanceChanged && !usageChanged && priorInstances.length > 0) {
    const activity = agent.activity || presence.activity;
    const lastSeenAt = latestTimestamp([presence.lastSeenAt, agent.lastSeenAt]);
    if (
      activity === presence.activity &&
      lastSeenAt === presence.lastSeenAt
    ) {
      return channel;
    }
  }

  const nextPresence: ChannelMemberPresence = {
    ...presence,
    label: presence.label || agent.name,
    email: presence.email || agent.email,
    avatarUrl: presence.avatarUrl || agent.avatarUrl,
    lastSeenAt: latestTimestamp([presence.lastSeenAt, agent.lastSeenAt]),
    activity: agent.activity || presence.activity,
    files: instanceChanged ? presence.files : agent.files || presence.files,
    intent: instanceChanged ? presence.intent : agent.intent || presence.intent,
    runtimeState: instanceChanged ? presence.runtimeState : agent.runtimeState || presence.runtimeState,
    usage: nextUsage,
    instances: instanceChanged ? nextInstances : presence.instances,
  };

  return replaceChannelMemberPresence(channel, agent.id, nextPresence);
}

export function patchChannelAgentPresenceFromMessage(
  channel: SerializedChannel,
  entry: ChannelMessage
): SerializedChannel {
  if (entry.from.kind !== "agent" || !entry.from.identityId) return channel;

  const member = entry.from.identityId;
  const presence = channel.memberPresence?.[member];
  const agentPresence = presence?.kind === "agent" ? presence : undefined;
  const currentInstances = agentPresence?.instances || [];
  const senderInstanceId = entry.from.instanceId;
  const senderChannelInstanceId = entry.from.channelInstanceId;
  const instanceIndex = currentInstances.findIndex(
    (instance) =>
      (senderInstanceId && instance.id === senderInstanceId) ||
      (senderChannelInstanceId && instance.channelInstanceId === senderChannelInstanceId)
  );
  const nextInstances = [...currentInstances];
  if (instanceIndex >= 0) {
    nextInstances[instanceIndex] = mergeAgentInstancePresence(nextInstances[instanceIndex], {
      id: nextInstances[instanceIndex].id,
      channelInstanceId: senderChannelInstanceId || nextInstances[instanceIndex].channelInstanceId,
      label: entry.from.instanceLabel || nextInstances[instanceIndex].label,
      connectedAt: nextInstances[instanceIndex].connectedAt,
      lastSeenAt: entry.sentAt,
      status: "busy",
      activity: nextInstances[instanceIndex].activity || "Processing",
      goal: entry.from.goal || nextInstances[instanceIndex].goal,
    });
  } else if (senderInstanceId && senderChannelInstanceId) {
    nextInstances.push({
      id: senderInstanceId,
      channelInstanceId: senderChannelInstanceId,
      label: entry.from.instanceLabel || entry.from.label,
      connectedAt: entry.sentAt,
      lastSeenAt: entry.sentAt,
      status: "busy",
      activity: "Processing",
      goal: entry.from.goal,
    });
  }

  const nextPresence: ChannelMemberPresence = {
    kind: "agent",
    ...agentPresence,
    label: agentPresence?.label || entry.from.agentName || entry.from.label,
    email: agentPresence?.email || entry.from.email,
    lastSeenAt: entry.sentAt,
    activity: agentPresence?.activity,
    goal: entry.from.goal || agentPresence?.goal,
    instances: nextInstances.length > 0 ? nextInstances : agentPresence?.instances,
  };

  return replaceChannelMemberPresence(channel, member, nextPresence);
}

export function agentMessageInstanceIdentityIncomplete(entry: ChannelMessage): boolean {
  return entry.from.kind === "agent" &&
    Boolean(entry.from.instanceId) &&
    !entry.from.channelInstanceId;
}

/**
 * Compares two presence values by what they say rather than by identity.
 *
 * Presence frames mostly repeat themselves, and the transport hands over a
 * freshly parsed object every time, so `===` cannot tell a real change from a
 * restatement. A key carrying `undefined` says nothing, so it reads the same
 * as an absent key.
 */
export function sameReportedPresenceValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftEntries = reportedPresenceEntries(left as Record<string, unknown>);
  const rightEntries = reportedPresenceEntries(right as Record<string, unknown>);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(right, key) &&
    sameReportedPresenceValue(value, (right as Record<string, unknown>)[key])
  );
}

function reportedPresenceEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value).filter(([, entry]) => entry !== undefined);
}

/**
 * Whether a report about an Instance is newer than what we hold, judged on
 * the Instance's lifecycle (status, rest and offlineReason) together with the
 * `lastSeenAt` it was observed at.
 *
 * Gone and machine-offline are only ever reported live, after everything the
 * Instance said before them, so they apply whatever their clock says. Every
 * other report, a resting snapshot included, applies only if it is not older
 * than the one we hold: a catalog page read before a wake must not put a
 * live Instance back to sleep, and a live report from before a sleep must not
 * wake it.
 */
export function instanceLifecycleReportApplies(
  current: SerializedAgentInstance,
  update: SerializedAgentInstance
): boolean {
  if (update.status === "offline" && !update.rest) return true;
  return timestampMs(update.lastSeenAt) >= timestampMs(current.lastSeenAt);
}

export function mergeAgentInstancePresence(
  current: SerializedAgentInstance,
  update: SerializedAgentInstance
): SerializedAgentInstance {
  // Catalog pages, resolve reads, realtime frames, messages and cached
  // snapshots replayed from the query cache all arrive here, often behind
  // newer state. One rule orders them all.
  if (!instanceLifecycleReportApplies(current, update)) return current;
  const connectedAt = earliestTimestamp([current.connectedAt, update.connectedAt]) ||
    update.connectedAt || current.connectedAt;
  // A reborn can retain its channel slot, but its runtime facts belong to the
  // new global instance. Only the slot's birth order crosses that boundary.
  if (current.id !== update.id) return { ...update, connectedAt };
  const merged: SerializedAgentInstance = {
    ...current,
    ...update,
    // The lifecycle is one fact: whether the Instance is live, resting or
    // offline, and why. It is taken whole from the report that won above and
    // never assembled field by field, so no report's rest can outlive the
    // status it came with (a wake must not keep the sleep's moon).
    status: update.status,
    rest: update.rest,
    offlineReason: update.offlineReason,
    // Presence updates are patches. Runtime heartbeats deliberately omit the
    // slower-changing presentation fields, so an omitted field must retain
    // its last reported value instead of erasing every visible tag.
    model: update.model ?? current.model,
    models: update.models ?? current.models,
    effort: update.effort ?? current.effort,
    commands: update.commands ?? current.commands,
    statusChips: update.statusChips ?? current.statusChips,
    gitBranch: update.gitBranch ?? current.gitBranch,
    channelInstanceId: update.channelInstanceId || current.channelInstanceId,
    label: update.label || current.label,
    // Keep the original birth clock so Agents detail order does not jump when
    // a live presence frame carries a newer socket connectedAt.
    connectedAt,
    lastSeenAt: latestTimestamp([current.lastSeenAt, update.lastSeenAt]) || current.lastSeenAt,
    activity: update.activity ?? (update.status === current.status ? current.activity : undefined),
    files: update.files || current.files,
    intent: update.intent || current.intent,
    runtimeState: update.runtimeState ?? (update.status === "busy" ? current.runtimeState : undefined),
    goal: update.goal || current.goal,
    // Never let a token-only usage patch wipe subscription quota meters.
    usage: mergeLlmUsagePreferringQuotas(current.usage, update.usage),
  };
  // A frame that restates what we already hold must hand back the object we
  // already hold. The Channel tree re-renders on Channel identity, so a new
  // instance object for an unchanged report moves the sidebar and the
  // timeline under the reader for no reported reason.
  return sameReportedPresenceValue(current, merged) ? current : merged;
}

export function replaceChannelMemberPresence(
  channel: SerializedChannel,
  member: string,
  presence: ChannelMemberPresence
): SerializedChannel {
  return {
    ...channel,
    memberPresence: {
      ...channel.memberPresence,
      [member]: presence,
    },
  };
}

export function channelsAfterAgentInstanceOffline(
  channels: SerializedChannel[],
  input: {
    channelId?: string;
    agentId?: string;
    instanceId?: string;
    channelInstanceId?: string;
  }
): SerializedChannel[] {
  if (!input.channelId || !input.agentId) return channels;
  const target = {
    agentId: input.agentId,
    instanceId: input.instanceId,
    channelInstanceId: input.channelInstanceId,
  };
  let changed = false;
  const next = channels.map((channel) => {
    if (channel.id !== input.channelId) return channel;
    const patched = removeChannelAgentInstancePresence(channel, target);
    if (patched !== channel) changed = true;
    return patched;
  });
  return changed ? next : channels;
}

export function removeChannelAgentInstancePresence(
  channel: SerializedChannel,
  input: {
    agentId: string;
    instanceId?: string;
    channelInstanceId?: string;
  }
): SerializedChannel {
  const presence = channel.memberPresence?.[input.agentId];
  if (!presence || presence.kind !== "agent") return channel;
  const prior = presence.instances || [];
  const nextInstances = prior.filter((instance) => {
    if (input.instanceId && instance.id === input.instanceId) return false;
    if (
      !input.instanceId &&
      input.channelInstanceId &&
      instance.channelInstanceId === input.channelInstanceId
    ) {
      return false;
    }
    return true;
  });
  if (nextInstances.length === prior.length) return channel;
  if (nextInstances.length === 0) {
    const { [input.agentId]: _removed, ...rest } = channel.memberPresence || {};
    return { ...channel, memberPresence: rest };
  }
  return replaceChannelMemberPresence(channel, input.agentId, {
    ...presence,
    instances: nextInstances,
  });
}

export type { ChannelReadStateUpdate } from "./channel-read-state";

export function updateChannelReadState(
  channels: SerializedChannel[],
  channelId: string,
  update: ChannelReadStateUpdate
): SerializedChannel[] {
  return channels.map((channel) => (
    channel.id === channelId ? withChannelReadState(channel, update) : channel
  ));
}

export function replaceSpace(spaces: SerializedSpace[], space: SerializedSpace): SerializedSpace[] {
  const exists = spaces.some((current) => current.id === space.id);
  const next = exists
    ? spaces.map((current) =>
        current.id === space.id ? mergeSpaceSnapshot(current, space) : current
      )
    : [...spaces, space];
  return sortSpaces(next);
}

export function replaceAgent(agents: SerializedAgent[], agent: SerializedAgent): SerializedAgent[] {
  const exists = agents.some((current) => current.id === agent.id);
  const next = exists
    ? agents.map((current) => (current.id === agent.id ? agent : current))
    : [...agents, agent];
  return next.sort((left, right) => left.name.localeCompare(right.name));
}

export function replaceWorkspace(
  workspaces: SerializedWorkspace[],
  workspace: SerializedWorkspace
): SerializedWorkspace[] {
  const key = workspaceKey(workspace);
  const exists = workspaces.some((current) => workspaceKey(current) === key);
  return exists
    ? workspaces.map((current) => (workspaceKey(current) === key ? workspace : current))
    : [...workspaces, workspace];
}

export function replaceAutomation(
  automations: SerializedAutomation[],
  automation: SerializedAutomation
): SerializedAutomation[] {
  const exists = automations.some((current) => current.id === automation.id);
  const next = exists
    ? automations.map((current) => (current.id === automation.id ? automation : current))
    : [...automations, automation];
  return sortAutomations(next);
}

export function emptyAgentConfigForm(): AgentConfigForm {
  const preset = agentPresetOrCustom("codex");
  return {
    spaceId: "",
    presetId: preset.id,
    name: "",
    runtime: preset.runtime,
    argsText: preset.defaultArgs.join("\n"),
  };
}

export function channelReadSequenceFromEvent(event: ObservabilityEvent): number | undefined {
  return validChannelReadSequence(event.metadata?.readSequence);
}

export { normalizeChannelSearchText } from "./workspace-shell-search-model";

export { mergeWorkspaceSearchResults } from "./workspace-shell-search-model";

export { channelReadCountsStorageKey } from "./workspace-shell-search-model";

export async function fetchWorkingSpace(token: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const data = await xmatrixApiRequest<{ value?: unknown; found?: boolean }>({
      url: `${WEB_PROXY_ROUTES.shared_memory}?key=${encodeURIComponent(WORKING_SPACE_KV_KEY)}`,
      token,
      signal,
    });
    return data.found && typeof data.value === "string" ? data.value : null;
  } catch {
    return null;
  }
}

async function requireMessageResponse(response: Response, fallback: string): Promise<ChannelMessage> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: ChannelMessage };
  if (!response.ok || !payload.message) throw new Error(payload.error || fallback);
  return payload.message;
}
