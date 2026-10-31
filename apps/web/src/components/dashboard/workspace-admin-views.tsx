"use client";

import { withChannelReadState, type ChannelReadStateUpdate } from "./channel-read-state";
import type { RealtimeCollectionCommit } from "./realtime-collection";
import type {
  AgentConfigForm,
} from "./workspace-shell-agent-config-types";

import { WORKING_SPACE_KV_KEY } from "./workspace-shell-constants";
import { useLatestComponentRelease, type LatestRelease, type ReleaseComponent } from "./latest-component-releases";
import { releaseNotesPath } from "@xmatrix/protocol";

import {
  accountQuotaUsageFromCandidates,
  agentPresetOrCustom,
  formatVersion,
  isChannelAttentionSummary,
  mergeAccountLevelLlmUsage,
  releaseVersionStatus,
  validChannelReadSequence,
} from "./workspace-shell-formatters";

import {
  presentationAttachmentKind,
} from "./workspace-shell-helpers";

import {
  compareChannelsForSidebar,
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
import {
} from "@/components/dashboard/human-profile-editor";
import {
  isValidChannelMessage,
} from "./workspace-shell-recovered";

import {
  mergeChannelViewerState,
  type ChannelViewerStateAuthority,
} from "./channel-viewer-state";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
} from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { relativeTime } from "./workspace-shell-presence";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { sameValue } from "../../lib/same-value";

import { LiquidGlassCard, WoodPanel } from "@/components/ui/material-surfaces";
import { statusChipClass } from "@/components/ui/status-tone";

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
  type DesktopWorkspaceCandidate,
} from "@/lib/desktop/bridge";

import { cn } from "@/lib/utils";

import { errorFromResponse, xmatrixApiRequest, requireResponseOk, xmatrixRawResponse, unexpectedResponse, requireField, requireJson } from "@/lib/query/api-client";
import { hubReadResponse } from "@/lib/query/hub-read";

import { recordOnboardingStep } from "@/lib/onboarding-funnel";
import { ChannelPresenceConflict, decodeChannelSnapshot, emptyChannelPresence, HUB_ROUTES, presenceInstanceId, reduceChannelPresence, WEB_PROXY_ROUTES, type AgentInstancePresence, type ChannelPresence, type SerializedChannel } from "@xmatrix/protocol";

import type {
  ChannelAttentionSnapshot,
  ChannelCatalogSyncMetadata,
  ChannelMessage,
  ObservabilityEvent,
  SerializedAgent,
  ChannelSnapshot,
  SerializedMachineDaemon,
  SerializedAutomation,
  SerializedAutomationCatalog,
  AutomationExpressionInput,
  AutomationUpdateRequest,
  SerializedSpace,
  SerializedWorkspace,
} from "@xmatrix/protocol";

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

/* A component behind the newest release of its channel shows only what is
   really happening: the live state its updater reports, or, where nothing
   reports one, how long ago that release came out until it is plainly late. */
const SELF_UPDATE_GRACE_MS: Record<ReleaseComponent, number> = {
  cli: 15 * 60_000,
  desktop: 24 * 60 * 60_000,
};

/** A component's version and, when it is behind its channel, what its update is doing. */
export function MachineVersionValue({ version, component, className, behind }: {
  version?: string;
  component: ReleaseComponent;
  className?: string;
  /** The live update state where an updater reports one (this machine's App). */
  behind?: (latestVersion: string, publishedAt?: string) => React.ReactNode;
}) {
  const latest = useLatestComponentRelease(component, version);
  const outdated = releaseVersionStatus(version, latest?.version) === "outdated" && latest;
  return (
    <span className={cn("flex min-h-5 min-w-0 flex-wrap items-center gap-1.5", className)}>
      <span className="min-w-0 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
        {version ? formatVersion(version) : "unknown"}
      </span>
      {outdated && (behind ? behind(latest.version, latest.publishedAt) : <ReleaseAge component={component} latest={latest} />)}
      <ReleaseNotesLink version={outdated ? latest.version : version} />
    </span>
  );
}

export function ReleaseAge({ component, latest }: { component: ReleaseComponent; latest: LatestRelease }) {
  const published = latest.publishedAt ? Date.parse(latest.publishedAt) : Number.NaN;
  const next = formatVersion(latest.version);
  if (Number.isFinite(published) && Date.now() - published <= SELF_UPDATE_GRACE_MS[component]) {
    return <VersionNote>{next} released {relativeTime(latest.publishedAt!)}</VersionNote>;
  }
  return (
    <NotUpdated>
      {next} was released {latest.publishedAt ? relativeTime(latest.publishedAt) : "earlier"} and this machine has not updated to it.{" "}
      <ComponentUpdateSteps component={component} />
    </NotUpdated>
  );
}

/** A plain note beside a version: what its update is doing right now. */
export function VersionNote({ busy, children }: { busy?: boolean; children: React.ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {busy && <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" />}
      {children}
    </span>
  );
}

/** A version that did not update: the mark opens why and the fix, in place. */
export function NotUpdated({ label = "Not updated", children }: { label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={statusChipClass("attention", "inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 px-1.5")}
      >
        <AlertTriangle className="size-3.5" />
        {label}
      </button>
      {open && <span className="order-last basis-full text-xs leading-5 text-muted-foreground">{children}</span>}
    </>
  );
}

const CLI_UPDATE_COMMAND = "xmatrix update";

/** How a component on another machine is updated by hand. */
export function ComponentUpdateSteps({ component }: { component: ReleaseComponent }) {
  const { copied, copy } = useCopyToClipboard(CLI_UPDATE_COMMAND);
  if (component === "desktop") {
    return <>Open xMatrix on that machine and choose Settings › Desktop app › Check for updates.</>;
  }
  return <>Run{" "}
    <button type="button" onClick={() => void copy()} title="Copy"
      className="inline-flex items-center gap-1 rounded bg-muted px-1 font-mono text-foreground">
      {CLI_UPDATE_COMMAND}
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>{" "}on that machine to update now.</>;
}

export function ReleaseNotesLink({ version }: { version?: string }) {
  const href = releaseNotesPath(version);
  return href ? <a href={href} target="_blank" rel="noreferrer" className="text-xs text-primary underline underline-offset-2">
    Release notes{version ? ` ${version}` : ""}
  </a> : null;
}

export type FetchedChannelCatalog = {
  channels: ChannelSnapshot[];
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
      xmatrixRawResponse(route, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: workspaceAttemptSignal(sequenceSignal),
      }),
      { signal: sequenceSignal },
    );
  } catch (error) {
    if (sequenceSignal.aborted) throw new DOMException("Channel list request timed out", "TimeoutError");
    throw error;
  }

  const data = await requireJson<{
    channels?: SerializedChannel[];
    catalogSync?: unknown;
    attentionSnapshot?: unknown;
  }>(res, sequenceSignal);
  const catalogSync = parsedChannelCatalogSync(data.catalogSync);
  const attentionSnapshot = parsedChannelAttentionSnapshot(data.attentionSnapshot);
  if (data.catalogSync !== undefined && !catalogSync) {
    throw new Error("Channel catalog sync metadata is invalid");
  }
  if (data.attentionSnapshot !== undefined && !attentionSnapshot) {
    throw new Error("Channel attention snapshot is invalid");
  }
  return {
    channels: sortChannels((data.channels || []).map(decodeChannelSnapshot)),
    ...(catalogSync ? { catalogSync } : {}),
    ...(attentionSnapshot ? { attentionSnapshot } : {}),
  };
}

export async function fetchChannels(
  token: string,
  options: { spaceId?: string } = {}
): Promise<ChannelSnapshot[]> {
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

/* The Spaces a signed-in person lands with. Someone with none is given their
   own, so the first screen is a Space they can act in rather than an empty
   app; the Hub creates it only for an account that has no Space at all.
   Only such a person counts `app_loaded` and `space_ready`, so the funnel
   tells a first load that never got this far from a Space that failed. */
export async function fetchSpacesForLanding(
  token: string,
  signal?: AbortSignal,
): Promise<SerializedSpace[]> {
  const spaces = await fetchSpaces(token, signal);
  if (spaces.length > 0) return spaces;
  recordOnboardingStep(token, { step: "app_loaded", surface: "shell" });
  const data = await xmatrixApiRequest<{ space?: SerializedSpace | null }>({
    url: WEB_PROXY_ROUTES.personal_space, token, method: "POST", signal,
  });
  const landed = data.space ? [data.space] : await fetchSpaces(token, signal);
  if (landed.length > 0) recordOnboardingStep(token, { step: "space_ready", surface: "shell" });
  return landed;
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
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.automation(automationId), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  return requireField<SerializedAutomation>(res, "automation", "The Automation");
}

export async function setAutomationPaused(
  token: string,
  automation: SerializedAutomation,
  paused: boolean
): Promise<SerializedAutomation> {
  const route = paused
    ? WEB_PROXY_ROUTES.automation_pause(automation.id)
    : WEB_PROXY_ROUTES.automation_resume(automation.id);
  const res = await xmatrixRawResponse(route, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: automation.version }),
    cache: "no-store",
  });
  return requireField<SerializedAutomation>(res, "automation", "The Automation");
}

/** The Automation as the Hub holds it now, or null once it is gone. */
export async function fetchAutomation(token: string, automationId: string): Promise<SerializedAutomation | null> {
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.automation(automationId), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  return requireField<SerializedAutomation>(res, "automation", "The Automation");
}

export async function removeAutomation(token: string, automation: SerializedAutomation): Promise<void> {
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.automation(automation.id), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: automation.version }),
    cache: "no-store",
  });
  await requireResponseOk(res, 404);
}

export async function registerWorkspace(
  token: string,
  candidate: DesktopWorkspaceCandidate
): Promise<SerializedWorkspace> {
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.workspaces, {
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

  if (!res.ok) throw await errorFromResponse(res);
  const payload = (await res.json().catch(() => ({}))) as { workspace?: SerializedWorkspace };
  if (!payload.workspace) throw unexpectedResponse("The workspace");
  return payload.workspace;
}

export async function deleteWorkspace(token: string, workspace: SerializedWorkspace): Promise<void> {
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.workspaces, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ machineId: workspace.machineId, canonicalCwd: workspace.canonicalCwd }),
    cache: "no-store",
  });
  await requireResponseOk(res, 404);
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
    /** Only what this kind of sender wrote. */
    senderKind?: "user" | "agent" | "app";
    signal?: AbortSignal;
  }
): Promise<ChannelHistoryPage> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.senderKind) params.set("senderKind", options.senderKind);
  if (options.beforeSequence !== undefined) {
    params.set("beforeSequence", String(options.beforeSequence));
  }
  if (options.before) params.set("before", options.before);
  if (options.afterSequence !== undefined) {
    params.set("afterSequence", String(options.afterSequence));
  }
  // From the Hub straight when it answers this page (lib/query/hub-read.ts), else through the Web.
  const res = await hubReadResponse({
    hubPath: `${HUB_ROUTES.channel_history(channelId)}?${params.toString()}`,
    webUrl: `${WEB_PROXY_ROUTES.channel_history(channelId)}?${params.toString()}`,
    token,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(CHANNEL_HISTORY_FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(CHANNEL_HISTORY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw await errorFromResponse(res);
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
  sequence: number,
  /** The reader has dealt with the mentions waiting on them here without replying. */
  responded = false,
): Promise<ChannelReadStateUpdate | undefined> {
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_read(channelId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(responded ? { sequence, responded } : { sequence }),
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
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_message_reactions(channelId, messageId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ emoji }),
    cache: "no-store",
  });

  return requireMessageResponse(res);
}

export async function updateChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
  body: string
): Promise<ChannelMessage> {
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_message(channelId, messageId), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body }),
    cache: "no-store",
  });

  return requireMessageResponse(res);
}

export async function recallChannelMessage(
  token: string,
  channelId: string,
  messageId: string
): Promise<ChannelMessage> {
  const res = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_message(channelId, messageId), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  return requireMessageResponse(res);
}

export function replaceChannel(channels: ChannelSnapshot[], channel: ChannelSnapshot | SerializedChannel): ChannelSnapshot[] {
  const index = channels.findIndex((current) => current.id === channel.id);
  const merged = mergeChannelListHydratedFields(index >= 0 ? channels[index] : undefined, channel);
  if (index < 0) return sortChannels([...channels, merged]);
  return placeChannel(channels, index, merged);
}

/** `channels` with the one at `index` replaced, and moved to where it now sorts when it left its place. */
export function placeChannel(channels: ChannelSnapshot[], index: number, channel: ChannelSnapshot): ChannelSnapshot[] {
  const next = channels.slice();
  next[index] = channel;
  // Most replacements (presence, read state, topic) leave a Channel where it
  // sorts; re-sorting a thousand Channels per realtime frame is what costs.
  const before = next[index - 1];
  const after = next[index + 1];
  if ((!before || compareChannelsForSidebar(before, channel) <= 0) &&
      (!after || compareChannelsForSidebar(channel, after) <= 0)) {
    return next;
  }
  // The others keep their order: only this one is taken out and put back
  // where a sort would leave it, among its equals as near as it stood.
  next.splice(index, 1);
  const bound = (afterEquals: boolean) => {
    let low = 0;
    let high = next.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const order = compareChannelsForSidebar(next[middle]!, channel);
      if (order < 0 || (afterEquals && order === 0)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  next.splice(Math.min(Math.max(index, bound(false)), bound(true)), 0, channel);
  return next;
}

export function mergeChannelListSnapshot(
  current: ChannelSnapshot[],
  incoming: (ChannelSnapshot | SerializedChannel)[],
): ChannelSnapshot[] {
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
  prior: ChannelSnapshot | undefined,
  incoming: ChannelSnapshot | SerializedChannel,
  viewerStateAuthority: ChannelViewerStateAuthority = "partial",
): ChannelSnapshot {
  const channel = decodeChannelSnapshot(incoming);
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
    presence: mergeChannelPresence(prior.presence, channel.presence),
  };
}

export function mergeChannelMemberReadSequences(
  prior: ChannelSnapshot["memberReadSequences"] | undefined,
  next: ChannelSnapshot["memberReadSequences"] | undefined
): ChannelSnapshot["memberReadSequences"] | undefined {
  if (!next) return prior;
  if (!prior) return next;
  const merged: NonNullable<ChannelSnapshot["memberReadSequences"]> = { ...prior };
  for (const [subjectId, sequence] of Object.entries(next)) {
    const previous = merged[subjectId];
    if (previous === undefined || sequence > previous) merged[subjectId] = sequence;
  }
  return merged;
}

/** Presence-only snapshots do not change the conversation catalog, reference
 * names, history audience or trace access. Every other field still does. */
export function sameChannelCatalogState(left: ChannelSnapshot, right: ChannelSnapshot): boolean {
  const { presence: _leftPresence, ...leftState } = left;
  const { presence: _rightPresence, ...rightState } = right;
  if (!sameValue(leftState, rightState)) return false;
  const ids = (channel: ChannelSnapshot) => new Set(channel.presence?.instances.keys() ?? []);
  const before = ids(left);
  const after = ids(right);
  return before.size === after.size && [...after].every(id => before.has(id));
}

export function mergeChannelPresence(prior: ChannelPresence | undefined,
  next: ChannelPresence | undefined): ChannelPresence | undefined {
  if (!next) return prior;
  if (!prior) return next;
  const merged = reduceChannelPresence(prior, { type: "snapshot", snapshot: next });
  return sameValue(prior, merged) ? prior : sameValue(next, merged) ? next : merged;
}

type ChannelPresenceRouting = {
  byInstance: Map<string, Set<string>>;
  positions: Map<string, number>;
  ordered: boolean;
};

/** Apply ordered presence and partial snapshots in one state-frame run. The
 * Channel table and routing indices are built once, rather than once per
 * alternating Agent/Channel pair. Snapshots still merge in their socket order. */
export function createChannelPresenceBatch(channels: ChannelSnapshot[], routing?: ChannelPresenceRouting) {
  const positionsFor = (items: ChannelSnapshot[]) => {
    const positions = new Map<string, number>();
    items.forEach((channel, index) => positions.set(channel.id, index));
    return positions;
  };
  // The private position index belongs to this exact input array and passes
  // to only one successor. Published arrays and commit indices never share it.
  // Ordinary reports stage only changed cards, without copying the catalog.
  const channelPositions = routing?.positions ?? positionsFor(channels);
  const updates = new Map<string, ChannelSnapshot>();
  const get = (id: string) => {
    const updated = updates.get(id);
    if (updated) return updated;
    const position = channelPositions.get(id);
    return position === undefined ? undefined : channels[position];
  };
  const values = function* () {
    for (const id of channelPositions.keys()) yield get(id)!;
    for (const [id, channel] of updates) if (!channelPositions.has(id)) yield channel;
  };
  let committed: RealtimeCollectionCommit<ChannelSnapshot> | undefined;
  let liveUpdates: ChannelSnapshot[] | undefined;
  let published: ChannelSnapshot[] | undefined;
  let publishedFromBasis = true;
  let sealed = false;
  const byInstance = routing?.byInstance ?? new Map<string, Set<string>>();
  let indexed = routing !== undefined;
  let routesTaken = false;
  const inputOrdered = routing?.ordered ?? false;
  let outputOrdered = inputOrdered;
  const reordered = new Set<string>();
  let appendedOnly = false;
  const routes = (channel: ChannelSnapshot) => ({ instances: [...(channel.presence?.instances.keys() ?? [])] });
  const route = (id: string, keys: ReturnType<typeof routes>, add: boolean) => {
    const update = (index: Map<string, Set<string>>, key: string) => {
      if (add) {
        let ids = index.get(key);
        if (!ids) index.set(key, ids = new Set());
        ids.add(id);
      } else {
        const ids = index.get(key);
        ids?.delete(id);
        if (!ids?.size) index.delete(key);
      }
    };
    for (const instance of keys.instances) update(byInstance, instance);
  };
  const put = (channel: ChannelSnapshot, rankMayChange = false) => {
    const previous = get(channel.id);
    if (previous === channel) return;
    // Validate the sort inputs too, including a new Channel: a later sort may
    // otherwise fail outside this frame's error boundary after staging it.
    if (rankMayChange) compareChannelsForSidebar(channel, channel);
    const rankChanged = rankMayChange && (!previous || compareChannelsForSidebar(previous, channel) !== 0);
    const before = indexed && previous ? routes(previous) : undefined;
    const after = routes(channel);
    if (before) route(channel.id, before, false);
    if (indexed) route(channel.id, after, true);
    // Presence leaves the sidebar rank alone. A new or renamed/reordered
    // snapshot gets the same comparator as replaceChannel, once at publication.
    if (rankChanged) reordered.add(channel.id);
    updates.set(channel.id, channel);
  };
  const snapshot = () => {
    if (published) return published;
    appendedOnly = false;
    if (!updates.size) return channels;
    const next = channelPositions.size === channels.length ? channels.slice() : [...values()];
    if (channelPositions.size === channels.length) {
      for (const [id, channel] of updates) {
        const position = channelPositions.get(id);
        if (position === undefined) next.push(channel);
        else next[position] = channel;
      }
    }
    if (!reordered.size) return next;
    outputOrdered = true;
    if (!inputOrdered || reordered.size > Math.max(8, next.length / 16)) return sortChannels(next);
    // The inherited order is already sorted. Move only the added/re-ranked
    // rows, keeping the full comparator and its original stable tie order.
    const ordered = next.filter(channel => !reordered.has(channel.id));
    appendedOnly = [...reordered].every(id => !channelPositions.has(id));
    let positions: Map<string, number> | undefined;
    const compare = (left: ChannelSnapshot, right: ChannelSnapshot) => {
      const rank = compareChannelsForSidebar(left, right);
      if (rank) return rank;
      positions ??= new Map(next.map((channel, index) => [channel.id, index]));
      return positions.get(left.id)! - positions.get(right.id)!;
    };
    for (const id of reordered) {
      const channel = get(id)!;
      let low = 0;
      let high = ordered.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(ordered[middle], channel) <= 0) low = middle + 1;
        else high = middle;
      }
      if (low < channels.length) appendedOnly = false;
      ordered.splice(low, 0, channel);
    }
    return ordered;
  };
  const requireUnpublished = () => {
    if (sealed) throw new Error("A published presence batch cannot be changed");
  };
  return {
    applyChannel(channel: ChannelSnapshot | SerializedChannel,
      beforeApply?: (previous: ChannelSnapshot | undefined, updated: ChannelSnapshot) => void) {
      requireUnpublished();
      const previous = get(channel.id);
      const updated = mergeChannelListHydratedFields(previous, channel);
      // Classification and access/history invalidation may fail. Keep the
      // prior state in that case, as replaceChannel's unpublished array did.
      beforeApply?.(previous, updated);
      put(updated, true);
      return { previous, updated };
    },
    applyPresence(agents: readonly SerializedAgent[]) {
      requireUnpublished();
      if (!agents.length) return;
      if (!indexed) {
        for (const channel of values()) {
          try {
            route(channel.id, routes(channel), true);
          } catch {
            // A malformed resident from an earlier hydration cannot block
            // reports for unrelated, valid Channels.
          }
        }
        indexed = true;
      }
      const positions = new Map<string, Set<number>>();
      const target = (id: string, position: number) => {
        if (!get(id)) return;
        let reports = positions.get(id);
        if (!reports) positions.set(id, reports = new Set());
        reports.add(position);
      };
      agents.forEach((agent, position) => {
        const instances = agent.instances ?? [];
        for (const instance of instances) {
          if (instance.channelId) target(instance.channelId, position);
          for (const id of byInstance.get(instance.id) ?? []) target(id, position);
        }
        if (!instances.length) for (const id of byInstance.get(agent.instanceId || agent.id) ?? []) target(id, position);
      });
      for (const [id, reports] of positions) {
        let patched = get(id)!;
        for (const position of reports) patched = patchChannelAgentPresenceFromAgent(patched, agents[position]);
        put(patched);
      }
    },
    getSnapshot: snapshot,
    /** Seal a rank-preserving live run for the collection's keyed receive. */
    getLiveUpdates(): readonly ChannelSnapshot[] | undefined {
      if (liveUpdates) return liveUpdates;
      requireUnpublished();
      if (reordered.size) return undefined;
      sealed = true;
      return liveUpdates = [...updates.values()];
    },
    /** Called by receive before subscribers: reentrant writes cannot change
     * which immutable snapshot this run's routing belongs to. */
    acceptLiveSnapshot(items: ChannelSnapshot[], previous: ChannelSnapshot[]) {
      if (!liveUpdates || published) throw new Error("A live presence snapshot must be accepted once after sealing");
      // Another collection can synchronously notify a writer before this run
      // reaches receive. Its result is valid, but the old routes/positions are
      // no longer an index of the snapshot against which receive merged.
      publishedFromBasis = previous === channels;
      published = items;
    },
    /** Catalog/rank changes retain a complete, immutable indexed fallback. */
    getCommit() {
      if (committed) return committed;
      requireUnpublished();
      const items = snapshot();
      const byId = new Map(items.map(channel => [channel.id, channel]));
      committed = { basis: channels, items, byId, changedKeys: [...updates.keys()] };
      published = items;
      sealed = true;
      return committed;
    },
    /** Only the exact next live snapshot can inherit a completed run's routes.
     * Taking consumes them even on mismatch; other writers force a rebuild. */
    takeRouting(basis: ChannelSnapshot[]) {
      const reusable = !routesTaken && indexed && publishedFromBasis && published === basis;
      routesTaken = true;
      if (!reusable) return undefined;
      let positions: Map<string, number>;
      if (!reordered.size && basis.length === channels.length) positions = channelPositions;
      else if (appendedOnly) {
        // Older first-seen Channels often append to a known catalog order.
        // The unchanged prefix needs no fresh index or key allocation.
        positions = channelPositions;
        for (let index = channels.length; index < basis.length; index += 1) positions.set(basis[index].id, index);
      } else positions = positionsFor(basis);
      return { byInstance, positions, ordered: outputOrdered };
    },
  };
}

export function patchChannelAgentPresenceFromAgent(channel: ChannelSnapshot,
  agent: SerializedAgent): ChannelSnapshot {
  let presence = channel.presence ?? emptyChannelPresence(channel.id);
  const knownActor = presence.instances.get(presenceInstanceId(agent.instanceId || agent.id));
  const reports = agent.instances?.length ? agent.instances : knownActor ? [knownActor] : [];
  const quota = accountQuotaUsageFromCandidates(agent.usage);
  for (const report of reports) {
    const id = presenceInstanceId(report.id);
    const current = presence.instances.get(id);
    if ((report.channelId && report.channelId !== channel.id) || (!current && report.channelId !== channel.id)) continue;
    if (!current) throw new ChannelPresenceConflict(channel.id, id);
    const next: AgentInstancePresence = { ...report, id, channelId: channel.id,
      agentName: current?.agentName || agent.name, registration: current.registration,
      email: current.email || agent.email,
      usage: mergeAccountLevelLlmUsage(report.usage ?? current?.usage, quota) };
    presence = reduceChannelPresence(presence, { type: "upsert", source: "live", instance: next });
  }
  return sameValue(presence, channel.presence) ? channel : { ...channel, presence };
}

/** A message is evidence of activity, never evidence of Channel residency. */
export function patchChannelAgentPresenceFromMessage(channel: ChannelSnapshot,
  entry: ChannelMessage): ChannelSnapshot {
  if (entry.from.kind !== "agent" || !entry.from.instanceId ||
      (entry.from.originChannelId && entry.from.originChannelId !== channel.id)) return channel;
  const id = presenceInstanceId(entry.from.instanceId);
  const current = channel.presence?.instances.get(id);
  if (!current) return channel;
  const presence = reduceChannelPresence(channel.presence!, { type: "patch_known", source: "message", instanceId: id,
    patch: { lastSeenAt: entry.sentAt, status: "busy", rest: undefined, offlineReason: undefined,
      goal: entry.from.goal || current.goal } });
  if (presence === channel.presence) return channel;
  return { ...channel, presence };
}

export function channelsAfterAgentInstanceOffline(
  channels: ChannelSnapshot[],
  input: {
    channelId?: string;
    agentId?: string;
    instanceId?: string;
    channelInstanceId?: string;
  }
): ChannelSnapshot[] {
  if (!input.channelId || !input.instanceId) return channels;
  const target = { instanceId: input.instanceId };
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
  channel: ChannelSnapshot,
  input: {
    instanceId: string;
  }
): ChannelSnapshot {
  if (!input.instanceId) throw new TypeError("An exact Instance identity is required for removal");
  if (!channel.presence) return channel;
  const presence = reduceChannelPresence(channel.presence,
    { type: "remove", instanceId: presenceInstanceId(input.instanceId) });
  return presence === channel.presence ? channel : { ...channel, presence };
}

export type { ChannelReadStateUpdate } from "./channel-read-state";

export function updateChannelReadState(
  channels: ChannelSnapshot[],
  channelId: string,
  update: ChannelReadStateUpdate
): ChannelSnapshot[] {
  return channels.map((channel) => (
    channel.id === channelId ? withChannelReadState(channel, update) : channel
  ));
}

export function replaceSpace(spaces: SerializedSpace[], space: SerializedSpace): SerializedSpace[] {
  const exists = spaces.some((current) => current.id === space.id);
  const next = exists
    ? spaces.map((current) =>
        current.id === space.id ? space : current
      )
    : [...spaces, space];
  return sortSpaces(next);
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

async function requireMessageResponse(response: Response): Promise<ChannelMessage> {
  if (!response.ok) throw await errorFromResponse(response);
  const payload = (await response.json().catch(() => ({}))) as { message?: ChannelMessage };
  if (!payload.message) throw unexpectedResponse("The message");
  return payload.message;
}
