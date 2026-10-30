"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { PrivateSignInEmail } from "./private-sign-in-email";
import { SignedInSessions } from "./signed-in-sessions";

import { actionClass } from "@/components/ui/action-tone";
import { ChannelTransferQueue } from "./channel-transfer-queue";
import { spaceSummary, TeamNewSpace, TeamOtherSpace } from "./team-spaces";
import { SpaceDangerZone } from "./space-deletion-panel";
import { SpaceOpenParticipation } from "./space-open-participation";

import {
  desktopDaemonLabel,
  desktopUpdateDescription,
  desktopUpdateLabel,
} from "./workspace-shell-desktop-labels";

import { type AppView } from "./workspace-shell-navigation";

import {
  spacePreferredLanguage,
} from "./workspace-shell-formatters";

import {
  SpaceInviteResult,
  SpaceInviteRole,
  SpaceMemberActionResult,
} from "./workspace-shell-helpers";

import type { SpaceJoinRequest } from "@/components/dashboard/space-join-requests";
import { HumanProfileSummary } from "@/components/dashboard/human-profile-summary";
import {
  canInviteToSpace,
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

import { ListSkeleton } from "./content-skeleton";
import {
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
  Monitor,
  X,
  Bell,
} from "lucide-react";
import { BrowserPushSetting, browserPushSummary } from "./browser-push-setting";
import { browserPushState, type BrowserPushState } from "@/lib/push-subscription";
import { SectionedToolView, ToolDetailSection, ToolSettingRow, type ToolSection } from "./tool-split";
import { spacePlansAbsent } from "./space-plan-mark";
import { SpaceBillingSection, spaceBillingSummary } from "./settings-billing";
import { SPACE_BILLING_SECTION, useSpaceBilling } from "./space-billing";

import { Textarea } from "@/components/ui/textarea";

import { GlassSelect } from "@/components/ui/glass-select";
import { Switch } from "@/components/ui/switch";

import { Input } from "@/components/ui/input";

import { noticeClass } from "@/components/ui/status-tone";

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
  type DesktopContext,
  type DesktopDaemonStatus,
  type DesktopUpdateStatus,
} from "@/lib/desktop/bridge";

import { cn } from "@/lib/utils";

import { BetaTag, tagClass } from "./status-tag";
import canonicalVersion from "../../../../../version.json" with { type: "json" };
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";

import type {
  SerializedSpace,
  SpaceMemberPermissions,
  HumanProfile,
} from "@xmatrix/protocol";

import { DetailRow, ReleaseNotesLink } from "./workspace-admin-views";

// Settings and Team: tool views the shell loads when one is first opened, kept
// apart from workspace-admin-views, whose data helpers the first screen uses.

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
        {installing ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <CircleArrowUp className="size-4" />}
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
      <AnimatedIcon icon={RefreshCw} className={cn("size-4", busy && "animate-spin")} />
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
  user: { id: string; email: string; name?: string };
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
  // A browser tab has no native notifications: it can be pushed to instead.
  const [pushState, setPushState] = useState<BrowserPushState | null>(null);
  useEffect(() => {
    if (!token || desktopAvailable) return;
    let current = true;
    void browserPushState(token).then((state) => { if (current) setPushState(state); }).catch(() => undefined);
    return () => { current = false; };
  }, [desktopAvailable, token]);
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
  const secretCatalogError = secretActionError ?? userErrorMessage(secretQuery.error, "Couldn't load secrets");
  const secretSaving = secretMutation.isPending && secretMutation.variables?.kind === "save";
  const deletingSecretRef = secretMutation.isPending && secretMutation.variables?.kind === "delete"
    ? secretMutation.variables.secretRef ?? null : null;

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
        current ? { ...current, error: userErrorMessage(err, "Couldn't save secret") ?? "" } : current
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
      setSecretCatalogError(userErrorMessage(err, "Couldn't delete secret"));
    }
  }

  // Settings reads like the other rail destinations: its sections in the list, one on the paper.
  const sections: ToolSection[] = [
    { key: "account", label: "Account", icon: UserRound, summary: user.email, content: (
        <div className="app-settings-section min-w-0 space-y-10">
          {/* Editing lives on the Profile view. Two editors would be two sources of truth for the
              same fields. */}
          <ToolDetailSection title="Profile" action={
            <button type="button" onClick={() => onChangeView("profile")} className={actionClass({ variant: "secondary", size: "sm" })}>
              <Pencil className="size-3.5" aria-hidden="true" />
              Edit profile
            </button>
          }>
            <HumanProfileSummary profile={profile} className="py-3" />
            <PrivateSignInEmail
              email={user.email}
              className="flex items-start gap-3 py-3.5"
              emailClassName="mt-1 truncate text-sm text-muted-foreground"
            />
          </ToolDetailSection>
          <ToolDetailSection title="Delete account">
            <ToolSettingRow
              title="Delete your account"
              description="Permanently removes your profile, sessions and private settings. Close the Spaces you own first."
              control={<a href="/account/delete" className={actionClass({ variant: "danger" })}>Delete account…</a>}
            />
          </ToolDetailSection>
        </div>
      ) },
    { key: "secrets", label: "Secrets", icon: Key,
      summary: secretCatalogLoaded ? `${secretCatalogEntries.length} in ${space?.name ?? "this Space"}` : "Stored values are never shown", content: (
        <div className="app-settings-section min-w-0">
          <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
            Secrets belong to {space?.name ?? "the Space"}. An Agent reads one when it needs it: an <b>auto</b> secret
            right away, an <b>ask</b> secret after a Space admin approves that Agent on a card in its Channel.
            Stored values are never shown.
          </p>
          <div className="mb-8 mt-4 flex flex-wrap items-center gap-2">
            {canManageSecrets && <button
              type="button"
              onClick={() => openSecretEditor("create")}
              disabled={!token || secretSaving}
              className={actionClass({ variant: "primary" })}
            >
              <Plus className="size-4" />
              New secret
            </button>}
            <button
              type="button"
              onClick={() => void loadSecretCatalog()}
              disabled={!token || secretCatalogLoading}
              className={actionClass({ variant: "quiet" })}
            >
              <AnimatedIcon icon={RefreshCw} className={cn("size-4", secretCatalogLoading && "animate-spin")} />
              Refresh
            </button>
          </div>

          {secretCatalogError && (
            <p className="mb-4 text-sm font-medium text-destructive">{secretCatalogError}</p>
          )}

          {secretEditor && (
            <form onSubmit={submitSecretCatalog} className="mb-10">
              <h3 className="app-tool-detail-section-title mb-4 pb-2 text-[15px] font-bold">{secretEditor.mode === "create" ? "New secret" : `Edit ${secretEditor.draft.secretRef}`}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-[13px] font-semibold">
                  <span>Alias</span>
                  <Input
                    value={secretEditor.draft.secretRef}
                    onChange={(event) => updateSecretDraft({ secretRef: event.target.value })}
                    disabled={secretEditor.mode === "edit" || secretSaving}
                    placeholder="api-dev-key"
                    className="h-9 font-mono"
                  />
                </label>
                <label className="grid gap-1.5 text-[13px] font-semibold">
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
                <label className="grid gap-1.5 text-[13px] font-semibold">
                  <span>Env</span>
                  <Input
                    value={secretEditor.draft.envName}
                    onChange={(event) => updateSecretDraft({ envName: event.target.value })}
                    disabled={secretSaving}
                    placeholder="PROVIDER_API_KEY"
                    className="h-9 font-mono"
                  />
                </label>
                <label className="grid gap-1.5 text-[13px] font-semibold">
                  <span>Agents get it</span>
                  <GlassSelect
                    value={secretEditor.draft.access}
                    onChange={(value) => updateSecretDraft({ access: value as SpaceSecretAccess })}
                    options={[
                      { value: "auto", label: "Automatically" },
                      { value: "ask", label: "After an admin approves" },
                    ]}
                    disabled={secretSaving}
                    className="h-9 px-3 text-sm font-medium disabled:cursor-not-allowed"
                  />
                </label>
                <label className="grid gap-1.5 text-[13px] font-semibold sm:col-span-2">
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
              <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSecretEditor(null)}
                  disabled={secretSaving}
                  className={actionClass({ variant: "quiet" })}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={secretSaving}
                  className={actionClass({ variant: "primary" })}
                >
                  {secretSaving ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <Check className="size-4" />}
                  Save secret
                </button>
              </div>
            </form>
          )}

          <ToolDetailSection title="Saved secrets">
            {secretCatalogLoading && secretCatalogEntries.length === 0 ? (
              <ListSkeleton label="Loading secrets" rows={3} mark={false} className="[--app-list-row-end:0px] [--app-list-row-start:0px]" />
            ) : secretCatalogEntries.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No saved secrets yet.</p>
            ) : (
              secretCatalogEntries.map((entry) => (
                <div key={entry.secretRef} className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="min-w-0 font-mono text-sm font-semibold [overflow-wrap:anywhere]">{entry.secretRef}</p>
                      <span className={tagClass("capitalize", secretAccessChipClass(entry.access))}>
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
                  {canManageSecrets && <div className="flex shrink-0 items-center gap-1">
                    {confirmingSecretRef === entry.secretRef ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void deleteSecret(entry)}
                          disabled={deletingSecretRef === entry.secretRef}
                          className={actionClass({ variant: "danger", size: "sm" })}
                        >
                          {deletingSecretRef === entry.secretRef ? (
                            <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingSecretRef(null)}
                          disabled={deletingSecretRef === entry.secretRef}
                          className={actionClass({ variant: "quiet", size: "sm" })}
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
                          className={actionClass({ variant: "quiet", size: "sm" })}
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
          </ToolDetailSection>
        </div>
      ) },
    // A deployment that meters nothing serves no Space billing, so it has no Billing section.
    ...(spacePlansAbsent(spaceBillingQuery.error) ? [] : [{
      key: SPACE_BILLING_SECTION, label: "Billing", icon: CreditCard, summary: spaceBillingSummary(spaceBillingQuery.data),
      content: <SpaceBillingSection userId={user.id} space={space} />,
    }]),
    ...(token && !desktopAvailable ? [{
      key: "notifications", label: "Notifications", icon: Bell, summary: browserPushSummary(pushState), content: (
        <div className="app-settings-section min-w-0">
          <BrowserPushSetting token={token} state={pushState} onState={setPushState} />
        </div>
      ) }] : []),
    { key: "desktop", label: "Desktop app", icon: Monitor, summary: desktopAvailable ? "Connected" : "Browser", content: (
        <div className="app-settings-section min-w-0 space-y-10">
          <ToolDetailSection title="This app" action={
            <span className="flex items-center gap-1.5">
              <BetaTag />
              <span className={tagClass()}>
                {desktopAvailable ? "Connected" : "Browser"}
              </span>
            </span>
          }>
            <div className="py-2 text-sm">
              <DetailRow label="Web version" value={canonicalVersion.version} />
              <DetailRow label="App version" value={desktopContext?.version || "-"} />
              <DetailRow label="Platform" value={desktopContext ? desktopContext.platform : "-"} />
              <DetailRow label="Updates" value={desktopUpdateLabel(desktopUpdateStatus, desktopAvailable, desktopUpdateBridgeAvailable)} />
            </div>
            {desktopUpdateStatus?.percent !== undefined && desktopUpdateStatus.state === "downloading" && (
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded bg-primary"
                  style={{ width: `${Math.max(0, Math.min(100, desktopUpdateStatus.percent))}%` }}
                />
              </div>
            )}
            <ToolSettingRow
              title="Updates"
              description={desktopUpdateDescription(desktopUpdateStatus, desktopAvailable, desktopUpdateBridgeAvailable)}
              control={desktopAvailable && desktopUpdateStatus?.enabled ? (
                <DesktopUpdateAction
                  status={desktopUpdateStatus}
                  checking={checkingDesktopUpdates}
                  onCheck={onCheckDesktopUpdates}
                  onInstall={onInstallDesktopUpdate}
                />
              ) : null}
            />
            <ReleaseNotesLink version={desktopUpdateStatus?.version || desktopContext?.version} />
          </ToolDetailSection>
          <ToolDetailSection title="Local daemon">
            <ToolSettingRow
              title={desktopDaemonLabel(desktopDaemonStatus, desktopAvailable)}
              description={desktopDaemonStatus?.message || "Opening the desktop app starts the local daemon automatically."}
              control={<>
                <button
                  onClick={onStartDesktopDaemon}
                  disabled={!desktopAvailable || daemonRunning || daemonBusy}
                  className={actionClass({ variant: "secondary" })}
                >
                  <Radio className="size-4" />
                  Start
                </button>
                <button
                  onClick={onStopDesktopDaemon}
                  disabled={!desktopAvailable || !daemonRunning}
                  className={actionClass({ variant: "secondary" })}
                >
                  <X className="size-4" />
                  Stop
                </button>
                <button
                  onClick={onRestartDesktopDaemon}
                  disabled={!desktopAvailable || daemonBusy}
                  className={actionClass({ variant: "secondary" })}
                >
                  <AnimatedIcon icon={RefreshCw} className={cn("size-4", daemonBusy && "animate-spin")} />
                  Restart
                </button>
              </>}
            />
          </ToolDetailSection>
        </div>
      ) },
    { key: "legal", label: "Legal and privacy", icon: Shield, summary: "Terms, privacy, cookies", content: (
        <div className="app-settings-section min-w-0">
          <p className="mb-4 max-w-[60ch] text-sm text-muted-foreground">
            Review the terms that apply to xMatrix and how MadeByRobot handles information.
          </p>
          <ToolDetailSection title="Documents">
            {([
              ["/privacy", "Privacy Policy"],
              ["/terms", "Terms of Service"],
              ["/cookies", "Cookies and Local Storage"],
              ["/subprocessors", "Subprocessors"],
            ] as const).map(([href, label]) => (
              <a key={href} href={href}
                className="flex items-center justify-between py-2.5 text-sm font-semibold hover:text-foreground/80">
                {label}
                <ChevronRight className="size-4 text-muted-foreground" />
              </a>
            ))}
          </ToolDetailSection>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Privacy, access, correction, and deletion requests can be sent to{" "}
            <a className="font-medium text-foreground underline underline-offset-4" href="mailto:contact@madebyrobot.net?subject=xMatrix%20privacy%20request">
              contact@madebyrobot.net
            </a>
            .
          </p>
        </div>
      ) },
    { key: "session", label: "Session", icon: LogOut, summary: "Where you're signed in", content: (
        <div className="app-settings-section min-w-0">
          <ToolDetailSection title="Signed in">
            <SignedInSessions token={token} />
          </ToolDetailSection>
          <ToolDetailSection title="Session">
            <ToolSettingRow
              title="Sign out"
              description="Sign out of this browser. Your computers and agents stay signed in."
              control={
                <button onClick={onLogout} className={actionClass({ variant: "danger" })}>
                  <LogOut className="size-4" />
                  Sign out
                </button>
              }
            />
          </ToolDetailSection>
        </div>
      ) },
  ];
  return <SectionedToolView title="Settings" sections={sections} />;
}

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


export function TeamView({
  token,
  user,
  currentSpace,
  error,
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
  spaces,
  creatingSpace,
  onCreateSpace,
  onSelectSpace,
}: {
  token?: string;
  user: { id: string; email: string; name?: string };
  currentSpace: SerializedSpace | null;
  error: string | null;
  joinRequestsBySpace: Record<string, SpaceJoinRequest[]>;

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
        [spaceId]: userErrorMessage(error, "Couldn't decide this request") ?? "",
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
        [space.id]: userErrorMessage(error, "Couldn't create the invite code") ?? "",
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
        [space.id]: { type: "error", message: userErrorMessage(err, "Couldn't send the invite") ?? "" },
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
      setMemberStatusBySpace(current => ({ ...current, [spaceId]: { type: "error", message: userErrorMessage(err, "Couldn't update the member") ?? "" } }));
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
        [space.id]: userErrorMessage(error, "Couldn't update member permissions") ?? "",
      }));
    } finally {
      setPermissionBusyBySpace((current) => ({ ...current, [space.id]: false }));
    }
  }

  // Team lists every workspace you belong to; the one you are in is managed beside the list, as
  // sections of settings rows on the paper.
  const currentContent = (
    <div className="app-team-view space-y-10">
      {currentSpace && ["owner", "admin"].includes(spaceRoleFor(currentSpace, user.id) || "") ? (
        <ChannelTransferQueue token={token} userId={user.id} spaceId={currentSpace.id} />
      ) : null}

      {error && <p className="text-sm font-medium text-destructive">{error}</p>}

      {teamSpaces.map((space) => {
        const canManage = canInviteToSpace(space, user.id);
        const memberPermissions = effectiveSpaceMemberPermissions(space);
        const permissionBusy = permissionBusyBySpace[space.id] === true;
        return (
          <div key={space.id} className="space-y-10">
            {canManage ? (
              <ToolDetailSection title="General">
                <ToolSettingRow
                  title="Language"
                  description="xMatrix speaks this language in this workspace."
                  control={
                    <GlassSelect
                      value={spacePreferredLanguage(space) || ""}
                      aria-label={`Preferred language for ${space.name}`}
                      options={[
                        { value: "", label: "Auto" },
                        { value: "zh", label: "中文" },
                        { value: "en", label: "English" },
                      ]}
                      onChange={(value) =>
                        void onUpdateSpacePreferredLanguage(space.id, value as "zh" | "en" | "").catch(() => undefined)
                      }
                      className="h-9 w-36 px-3 text-sm font-medium"
                    />
                  }
                />
                {token ? <SpaceOpenParticipation spaceId={space.id} token={token} /> : null}
              </ToolDetailSection>
            ) : null}

            <ToolDetailSection title="Members can create">
              {([
                ["agentCreation", "Agents", "Allow members to add agents", "add agents"],
                ["automationCreation", "Automations", "Allow members to create automations", "create automations"],
              ] as const).map(([capability, title, label, verb]) => {
                const open = memberPermissions[capability] === "members";
                return (
                  <ToolSettingRow
                    key={capability}
                    title={title}
                    description={`${open ? `Any member may ${verb}` : `Only owners and admins ${verb}`}. Existing ones keep working.`}
                    control={<>
                      {permissionBusy ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin text-muted-foreground" /> : null}
                      <Switch
                        label={label}
                        checked={open}
                        disabled={!canManage || permissionBusy}
                        onChange={(next) => void updateMemberPermission(space, capability, next)}
                      />
                    </>}
                  />
                );
              })}
              {!canManage ? (
                <p className="mt-2 text-xs text-muted-foreground">Only owners and admins can change these.</p>
              ) : null}
              {permissionErrorBySpace[space.id] ? (
                <p className="mt-2 text-xs font-medium text-destructive">{permissionErrorBySpace[space.id]}</p>
              ) : null}
            </ToolDetailSection>

            <ToolDetailSection title="Members">
              {canManage && (
                <form
                  className="mb-3 mt-2 flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitInvite(space);
                  }}
                >
                  <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-3 text-sm">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <input
                      value={inviteEmailsBySpace[space.id] || ""}
                      onChange={(event) =>
                        setInviteEmailsBySpace((current) => ({ ...current, [space.id]: event.target.value }))
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
                    {invitingSpaceId === space.id ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <Send className="size-4" />}
                    Invite
                  </button>
                </form>
              )}
              {canManage && (
                <div className="mb-2 space-y-2">
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
                </div>
              )}
              {/* A list on the paper, as GitHub and Notion draw members: a quiet
                  header and hairlines between rows, no frame around them. */}
              <div>
                <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1.8fr)_140px_32px] gap-3 py-2 text-xs font-medium text-muted-foreground md:grid">
                  <span>Name</span>
                  <span>Email</span>
                  <span>Role</span>
                  <span className="sr-only">Remove</span>
                </div>
                    {space.members.map((member) => {
                      const memberLabel = member.name || member.email || shortId(member.userId);
                      const canEditMember = canManage && member.role !== "owner" && member.userId !== user.id;
                      const roleActionKey = `${space.id}:${member.userId}:role`;
                      const removeActionKey = `${space.id}:${member.userId}:remove`;
                      return (
                      <div
                        key={member.userId}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-2.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.8fr)_140px_32px] md:gap-3"
                      >
                        <div className="col-span-2 min-w-0 md:col-span-1">
                          <p className="truncate text-sm font-bold text-foreground">{memberLabel}</p>
                          <p className="truncate text-xs text-muted-foreground md:hidden">{member.email || member.userId}</p>
                        </div>
                        <div className="hidden min-w-0 md:block">
                          <p className="truncate text-sm text-muted-foreground">{member.email || member.userId}</p>
                        </div>
                        {member.role === "owner" ? (
                          <span className="text-sm text-muted-foreground">Owner</span>
                        ) : (
                          <GlassSelect
                            value={member.role}
                            disabled={!canEditMember || memberActionKey === roleActionKey}
                            options={[
                              { value: "admin", label: "Admin" },
                              { value: "member", label: "Member" },
                              { value: "viewer", label: "Viewer" },
                            ]}
                            onChange={(value) =>
                              void updateMemberRole(space, member.userId, value as SpaceInviteRole)
                            }
                            aria-label={`Role for ${memberLabel}`}
                            className="h-8 w-full px-2.5 text-[13px] font-medium disabled:cursor-not-allowed"
                          />
                        )}
                        <div className="flex justify-end">
                          {canEditMember ? (
                          <button
                            type="button"
                            onClick={() => void removeMember(space, member.userId, memberLabel)}
                            disabled={memberActionKey === removeActionKey}
                            title={`Remove ${memberLabel}`}
                            className={actionClass({ variant: "quiet", size: "icon" }, "shrink-0")}
                          >
                            {memberActionKey === removeActionKey ? (
                              <AnimatedIcon icon={Loader2} className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4" />
                            )}
                          </button>
                          ) : null}
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
              {canManage && (joinRequestsBySpace[space.id] || []).length > 0 ? (
                <div className="mt-3">
                      {(joinRequestsBySpace[space.id] || []).length > 0 && (
                        <div className="flex flex-col">
                          <p className="py-2 text-[13px] font-semibold">
                            Waiting for you ({(joinRequestsBySpace[space.id] || []).length})
                          </p>
                          {(joinRequestsBySpace[space.id] || []).map((request) => (
                            <div
                              key={request.id}
                              className="flex flex-wrap items-center gap-2 py-2 text-sm"
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
                </div>
              ) : null}
              {canManage && (
                <ToolSettingRow
                  title="Invite link"
                  description="Anyone who opens the link joins this workspace as a member."
                  control={
                    <button
                      type="button"
                      disabled={creatingCodeSpaceId === space.id}
                      onClick={() => void submitInviteCode(space)}
                      className={actionClass({ variant: "secondary", size: "md" })}
                    >
                      {creatingCodeSpaceId === space.id ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <LinkIcon className="size-3.5" />}
                      Create link
                    </button>
                  }
                  below={
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-4 text-[13px] text-muted-foreground">
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={codeApprovalBySpace[space.id] === true}
                            onChange={(event) =>
                              setCodeApprovalBySpace((current) => ({ ...current, [space.id]: event.target.checked }))
                            }
                          />
                          Require my approval
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={codeUnlimitedBySpace[space.id] === true}
                            onChange={(event) =>
                              setCodeUnlimitedBySpace((current) => ({ ...current, [space.id]: event.target.checked }))
                            }
                          />
                          Unlimited uses
                        </label>
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
                  }
                />
              )}
            </ToolDetailSection>

            {spaceRoleFor(space, user.id) === "owner" ? (
              <SpaceDangerZone space={space} userId={user.id} onDeleteSpace={onDeleteSpace} />
            ) : null}
          </div>
        );
      })}

      {teamSpaces.length === 0 && (
        <p className="text-sm text-muted-foreground">Open a Space to manage its members and invitations.</p>
      )}
    </div>
  );
  return (
    <SectionedToolView title="Team" selectionParameter="space" defaultKey={currentSpace?.id} sections={[
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
            error={error}
            onCreateSpace={onCreateSpace}
            onRestoreSpace={onRestoreSpace}
          />
        ) },
    ]} />
  );
}
