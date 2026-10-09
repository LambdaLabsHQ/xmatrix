"use client";

/* The channel rail's Subscriptions block: what outside events this channel
 * receives. Each row is a source — a repository and the events it delivers —
 * not a provider. Whether the Space is connected to the provider at all is the
 * Apps page's question; the rail only raises it when a connection a
 * subscription depends on is broken, or when there is none to subscribe with.
 *
 * Every write goes out as the same `@github:subscribe:<owner>/<repo> <features>`
 * channel message a human would type — one message per decision, carrying a
 * statement per line when the edit both adds and drops events. That keeps one
 * write path for one piece
 * of state: the Hub's connector adapter still runs the capability check,
 * registers the webhook routes, records the execution and posts the audit line,
 * and the panel re-reads itself off that completion message (connectorRevision).
 * A direct HTTP mutation would need a second copy of all of it.
 */

import { ContentSkeleton } from "./content-skeleton";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, PlugZap, Plus, X } from "lucide-react";
import {
  GITHUB_DEFAULT_REPOSITORY_FEATURES,
  GITHUB_REPOSITORY_FEATURES,
  GITHUB_REPOSITORY_FEATURE_LABELS,
  WEB_PROXY_ROUTES,
  githubRequiredCapabilities,
  type AppConnectorCompletionResponse,
  type GitHubRepositoryFeature,
  type SerializedAppConnectorChannelSubscription,
  type SerializedAppConnectorConnection,
} from "@xmatrix/protocol";

import {
  githubFeatureCommand,
  githubSubscribeCommand,
  githubSubscriptionFeatures,
  githubSubscriptionRepository,
  githubSubscriptionSource,
  githubToggledFeatures,
  githubUnsubscribeCommand,
  type ChannelConnectorCommand,
} from "./channel-connector-commands";

import { GlassSelect } from "@/components/ui/glass-select";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { APP_CONNECTORS } from "@/lib/app-connectors";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { cn } from "@/lib/utils";

import { DetailBlock } from "./workspace-admin-views";
import { connectorConnectionStatusLabel, connectorIcon } from "./workspace-fleet-views";
import { COUNT_CHIP_MATERIAL_CLASS } from "./workspace-shell-constants";

/* A posted command is only confirmed when the connector's own completion line
   lands in the channel. A blocked or failed command changes nothing, so the row
   would stay locked forever without a ceiling. */
const CONNECTOR_COMMAND_TIMEOUT_MS = 45_000;

/* The only provider whose subscriptions the rail can write. Every other
   connection's subscriptions still list here, read-only. */
const SUBSCRIBABLE_PROVIDER_ID = "github";

/* The rail's actions are the same glass as its tags and the composer's
   buttons, poured over the plank, not the board's action material. */
const GLASS_ACTION_SM = "inline-flex h-7 items-center px-3 text-xs font-bold disabled:pointer-events-none disabled:opacity-50";

function connectionRepository(connection: SerializedAppConnectorConnection): string | undefined {
  const metadata = connection.metadata || {};
  const value = typeof metadata.repository === "string"
    ? metadata.repository
    : typeof metadata.githubRepository === "string"
      ? metadata.githubRepository
      : undefined;
  return value?.trim() || undefined;
}

function providerIcon(connection: SerializedAppConnectorConnection) {
  const connector = APP_CONNECTORS.find((candidate) => candidate.id === connection.providerId);
  return connector ? connectorIcon(connector) : PlugZap;
}

/* The dot is filled for on and hollow for off rather than green for on: the
   wood theme sweeps every saturated accent utility (`bg-emerald-*`, `bg-amber-*`
   and friends) to a neutral tint, so a colour-coded dot renders as a grey
   speck that says nothing. Fill is the signal the material does carry. */
function StatusPill({
  tone,
  children,
}: {
  tone: "good" | "bad" | "quiet";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
        tone === "good" ? "text-foreground" : tone === "bad" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          tone === "good" ? "bg-foreground" : "border border-current opacity-60",
        )}
      />
      {children}
    </span>
  );
}

function FeatureChip({
  feature,
  selected,
  disabled,
  title,
  onToggle,
}: {
  feature: GitHubRepositoryFeature;
  selected: boolean;
  disabled: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      className={cn(
        "px-2 py-0.5 text-[11px] font-medium disabled:pointer-events-none disabled:opacity-50",
        selected
          ? `${COUNT_CHIP_MATERIAL_CLASS} text-foreground`
          : "rounded-full border border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {GITHUB_REPOSITORY_FEATURE_LABELS[feature]}
    </button>
  );
}

/* Owner then repository, the same two-step the composer completion walks. The
   options come from the connector's own completion endpoint, so the panel can
   only offer repositories the installation actually reaches. */
function RepositoryPicker({
  userId,
  spaceId,
  channelId,
  providerId,
  token,
  value,
  onChange,
}: {
  userId: string;
  spaceId: string;
  channelId: string;
  providerId: string;
  token?: string;
  value: string;
  onChange: (repository: string) => void;
}) {
  const [owner, repo] = value.split("/", 2);
  const optionsQuery = (source: "github-organizations" | "github-repositories", parent?: string) =>
    ({
      queryKey: xmatrixQueryKeys.domain(
        { userId },
        "channel-connector-completion",
        [spaceId, channelId, providerId, source, parent ?? null],
      ),
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        xmatrixApiRequest<AppConnectorCompletionResponse>({
          url: WEB_PROXY_ROUTES.space_app_connection_completion(
            spaceId,
            providerId,
            source,
            channelId,
            parent,
          ),
          token,
          signal,
        }).then((payload) => payload.options ?? []),
      enabled: Boolean(token) && (source === "github-organizations" || Boolean(parent)),
    });

  const owners = useQuery(optionsQuery("github-organizations"));
  const repositories = useQuery(optionsQuery("github-repositories", owner || undefined));

  /* The completion endpoint 409s when the connector is not enabled here, and a
     bare installation can also list nothing. Typing the full name still works,
     so never let a failed listing become a dead end. */
  if (owners.isFetching && !owners.data) {
    return <ContentSkeleton label="Loading owners" lines={2} />;
  }

  if (owners.isError || (!owners.isFetching && (owners.data ?? []).length === 0)) {
    return (
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.trim())}
        placeholder="owner/repository"
        aria-label="GitHub repository"
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] text-foreground"
      />
    );
  }

  return (
    <div className="space-y-1.5">
      {/* The empty row is a real option, not the placeholder. A placeholder is
          only ever displayed, so dropping these when the native control went
          away would have left no way to undo a wrong owner — and clearing the
          owner is what resets the repository below it. */}
      <GlassSelect
        value={owner || ""}
        aria-label="GitHub owner"
        placeholder="Owner"
        options={[
          { value: "", label: "Owner" },
          ...(owners.data ?? []).map((option) => ({ value: option.value, label: option.label })),
        ]}
        onChange={(next) => onChange(next ? `${next}/` : "")}
        className="h-auto w-full rounded-md px-2 py-1 text-[12px] text-foreground"
      />
      {owner && repositories.isFetching && !repositories.data ? (
        <ContentSkeleton label="Loading repositories" lines={1} />
      ) : (
      <GlassSelect
        value={repo || ""}
        aria-label="GitHub repository"
        disabled={!owner}
        placeholder="Repository"
        options={[
          { value: "", label: "Repository" },
          ...(repositories.data ?? []).map((option) => ({ value: option.value, label: option.label })),
        ]}
        onChange={(next) => onChange(next ? `${owner}/${next}` : `${owner}/`)}
        className="h-auto w-full rounded-md px-2 py-1 text-[12px] text-foreground disabled:opacity-50"
      />
      )}
    </div>
  );
}


function SubscribeForm({
  userId,
  spaceId,
  channelId,
  providerId,
  token,
  defaultRepository,
  capabilities,
  onSubmit,
  onCancel,
}: {
  userId: string;
  spaceId: string;
  channelId: string;
  providerId: string;
  token?: string;
  defaultRepository?: string;
  capabilities: Set<string>;
  onSubmit: (command: ChannelConnectorCommand) => void;
  onCancel: () => void;
}) {
  const [repository, setRepository] = useState(defaultRepository ?? "");
  const [features, setFeatures] = useState<GitHubRepositoryFeature[]>(
    [...GITHUB_DEFAULT_REPOSITORY_FEATURES],
  );
  const command = githubSubscribeCommand(repository, features);

  return (
    <div className="space-y-2 border-t border-border/60 pt-2">
      <RepositoryPicker
        userId={userId}
        spaceId={spaceId}
        channelId={channelId}
        providerId={providerId}
        token={token}
        value={repository}
        onChange={setRepository}
      />
      <div className="flex flex-wrap gap-1">
        {GITHUB_REPOSITORY_FEATURES.map((feature) => {
          const missing = githubRequiredCapabilities([feature])
            .filter((capability) => !capabilities.has(capability));
          return (
            <FeatureChip
              key={feature}
              feature={feature}
              selected={features.includes(feature)}
              disabled={missing.length > 0}
              title={missing.length > 0
                ? `GitHub access for ${GITHUB_REPOSITORY_FEATURE_LABELS[feature]} is not granted (${missing.join(", ")})`
                : `Deliver ${GITHUB_REPOSITORY_FEATURE_LABELS[feature]} to this channel`}
              onToggle={() => setFeatures((current) => githubToggledFeatures(current, feature))}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <LiquidGlassPill
          as="button"
          type="button"
          disabled={!command}
          onClick={() => command && onSubmit(command)}
          className={GLASS_ACTION_SM}
        >
          Subscribe
        </LiquidGlassPill>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* A subscription reads as one line — the source plus the events it actually
   delivers — until it is opened. Eight permanently visible toggles per
   repository turned the rail into a control panel you had to read past to see
   what the channel was even subscribed to.

   Opened, the chips are a draft. Selecting is selecting: a chip says whether
   the event is on, and clicking it changes that and nothing else. Only Save
   posts, and it posts the whole edit as one command — the earlier design sent a
   connector command per click, so choosing three events wrote three messages
   into the channel and left three audit lines for one decision. */
function SubscriptionRow({
  connection,
  subscription,
  capabilities,
  editable,
  busy,
  onRunCommand,
}: {
  connection: SerializedAppConnectorConnection;
  subscription: SerializedAppConnectorChannelSubscription;
  capabilities: Set<string>;
  editable: boolean;
  busy: boolean;
  onRunCommand?: (command: ChannelConnectorCommand) => void;
}) {
  const [draft, setDraft] = useState<GitHubRepositoryFeature[] | null>(null);
  const Icon = providerIcon(connection);
  const repository = githubSubscriptionRepository(subscription.source);
  /* Only a repository subscription is addressable by `@github:subscribe:owner/repo`.
     An issue subscription reads here but is edited where it was made. */
  const editableHere = editable && subscription.kind === "repository";
  const current = githubSubscriptionFeatures(subscription.features);
  const providerFeatures = APP_CONNECTORS.find((connector) => connector.id === connection.providerId)?.events?.features;
  const eventLabels = connection.providerId === "github"
    ? current.map((feature) => GITHUB_REPOSITORY_FEATURE_LABELS[feature])
    : subscription.features.map((feature) =>
      providerFeatures?.find((candidate) => candidate.id === feature)?.label ?? feature);
  const summary = eventLabels.length > 0
    ? eventLabels.join(" · ")
    : "No events";
  const open = draft !== null;
  const selection = draft ?? current;
  const command = githubFeatureCommand(repository, current, selection);

  return (
    <div className="flex items-start gap-2.5 border-t border-border/60 py-2 first:border-t-0 first:pt-0">
      <Icon className="size-7" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground" title={subscription.source}>
              {repository}
            </p>
            {/* The events wrap rather than truncate: they are the answer to what
                this channel receives, and an ellipsis hides exactly that. */}
            <p className="text-[11px] leading-snug text-muted-foreground">
              {summary}
            </p>
          </div>
          {editableHere ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setDraft(open ? null : current)}
              className="shrink-0 pt-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              {open ? "Cancel" : "Edit"}
            </button>
          ) : null}
        </div>
        {open && editableHere ? (
          <div className="mt-1.5 space-y-1.5">
            <div className="flex flex-wrap gap-1">
              {GITHUB_REPOSITORY_FEATURES.map((feature) => {
                const missing = githubRequiredCapabilities([feature])
                  .filter((capability) => !capabilities.has(capability));
                const selected = selection.includes(feature);
                return (
                  <FeatureChip
                    key={feature}
                    feature={feature}
                    selected={selected}
                    disabled={busy || (!selected && missing.length > 0)}
                    title={!selected && missing.length > 0
                      ? `GitHub access for ${GITHUB_REPOSITORY_FEATURE_LABELS[feature]} is not granted (${missing.join(", ")})`
                      : selected
                        ? `Deliver ${GITHUB_REPOSITORY_FEATURE_LABELS[feature]} here (selected)`
                        : `Deliver ${GITHUB_REPOSITORY_FEATURE_LABELS[feature]} here`}
                    onToggle={() => setDraft(githubToggledFeatures(selection, feature))}
                  />
                );
              })}
            </div>
            <div className="flex items-center gap-3">
              <LiquidGlassPill
                as="button"
                type="button"
                disabled={busy || !command}
                title={command
                  ? `Apply this event selection to ${repository}`
                  : "No change to apply"}
                onClick={() => {
                  if (!command || !onRunCommand) return;
                  onRunCommand(command);
                  setDraft(null);
                }}
                className={GLASS_ACTION_SM}
              >
                Save
              </LiquidGlassPill>
              <button
                type="button"
                disabled={busy}
                title={`Unsubscribe ${repository} from this channel`}
                onClick={() => {
                  const unsubscribe = githubUnsubscribeCommand(repository);
                  if (!unsubscribe || !onRunCommand) return;
                  onRunCommand(unsubscribe);
                  setDraft(null);
                }}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="size-3" />
                Unsubscribe
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* A working connection is the default and goes unsaid. Only a broken one that
   this channel's subscriptions depend on speaks up, because those stop
   delivering until it is fixed in Apps. */
function ConnectionProblem({
  connection,
  onManageApps,
}: {
  connection: SerializedAppConnectorConnection;
  onManageApps: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <StatusPill tone={connection.status === "error" ? "bad" : "quiet"}>
        {connection.providerName} · {connectorConnectionStatusLabel(connection.status)}
      </StatusPill>
      <button
        type="button"
        onClick={onManageApps}
        title={connection.error || undefined}
        className="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        Fix in Apps
      </button>
    </div>
  );
}

export function ChannelSubscriptionsBlock({
  connections,
  userId,
  spaceId,
  channelId,
  token,
  connectorRevision,
  onRunConnectorCommand,
  onManageApps,
}: {
  connections: SerializedAppConnectorConnection[];
  userId: string;
  spaceId?: string;
  channelId?: string;
  token?: string;
  /** Id of the connector completion message the current state was read at. */
  connectorRevision?: string;
  onRunConnectorCommand?: (body: string) => void;
  onManageApps: () => void;
}) {
  const [pending, setPending] = useState<{ source: string; at: number } | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const subscribed = useMemo(
    () => connections.filter((connection) => (connection.channelState?.subscriptions?.length ?? 0) > 0),
    [connections],
  );
  const broken = subscribed.filter((connection) => connection.status !== "configured");
  const github = connections.find((connection) => connection.providerId === SUBSCRIBABLE_PROVIDER_ID);
  const githubConnected = github?.status === "configured";
  const githubCapabilities = useMemo(() => new Set(github?.capabilities || []), [github?.capabilities]);
  const githubSubscriptions = github?.channelState?.subscriptions || [];
  const defaultRepository = github ? connectionRepository(github) : undefined;

  /* The confirming message is what the connector query is keyed on, so a new
     revision means this panel is already showing the result. */
  useEffect(() => setPending(null), [connectorRevision, channelId]);
  useEffect(() => setSubscribing(false), [channelId]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(
      () => setPending(null),
      Math.max(0, pending.at + CONNECTOR_COMMAND_TIMEOUT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pending]);

  const runCommand = onRunConnectorCommand
    ? (command: ChannelConnectorCommand) => {
        setPending({ source: command.source, at: Date.now() });
        setSubscribing(false);
        onRunConnectorCommand(command.body);
      }
    : undefined;

  /* The rail shows only what this channel has; a channel with no subscriptions
     draws no plank. Subscribing starts from the command in the conversation. */
  if (subscribed.length === 0 && !pending) return null;

  return (
    <DetailBlock title="Subscriptions">
      <div className="space-y-2">
        {subscribed.length === 0 ? null : (
          <div>
            {broken.map((connection) => (
              <ConnectionProblem key={connection.id} connection={connection} onManageApps={onManageApps} />
            ))}
            {subscribed.flatMap((connection) => {
              const capabilities = new Set(connection.capabilities || []);
              const editable = Boolean(runCommand)
                && connection.providerId === SUBSCRIBABLE_PROVIDER_ID
                && connection.status === "configured";
              return (connection.channelState?.subscriptions || []).map((subscription) => (
                <SubscriptionRow
                  key={`${connection.id}:${subscription.kind}:${subscription.source}`}
                  connection={connection}
                  subscription={subscription}
                  capabilities={capabilities}
                  editable={editable}
                  busy={pending?.source === subscription.source.toLowerCase()}
                  onRunCommand={runCommand}
                />
              ));
            })}
          </div>
        )}

        {pending ? (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Sent to this channel. GitHub confirms here when it lands.
          </p>
        ) : null}

        {!runCommand || (github && broken.includes(github)) ? null : subscribing && github && githubConnected ? (
          <SubscribeForm
            userId={userId}
            spaceId={spaceId!}
            channelId={channelId!}
            providerId={github.providerId}
            token={token}
            defaultRepository={githubSubscriptions.some((subscription) =>
              subscription.source.toLowerCase() === githubSubscriptionSource(defaultRepository ?? ""))
              ? undefined
              : defaultRepository}
            capabilities={githubCapabilities}
            onSubmit={runCommand}
            onCancel={() => setSubscribing(false)}
          />
        ) : (
          /* Without a working GitHub connection there is nothing to subscribe
             with, so the same button says so and leads to where it is made. */
          <LiquidGlassPill
            as="button"
            type="button"
            onClick={githubConnected ? () => setSubscribing(true) : onManageApps}
            className="inline-flex h-9 items-center gap-2 px-4 text-sm font-bold"
          >
            <Plus className="size-3.5" />
            {githubConnected ? "Subscribe" : "Connect GitHub to subscribe"}
          </LiquidGlassPill>
        )}
      </div>
    </DetailBlock>
  );
}
