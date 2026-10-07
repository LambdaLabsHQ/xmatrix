"use client";

import { useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Cpu,
  Download,
  HardDrive,
  Loader2,
  Plus,
  RotateCcw,
  Settings,
} from "lucide-react";
import {
  WEB_PROXY_ROUTES,
  agentPresetAvatarUrl,
  normalizeAgentPresetRuntime,
  type AgentRegistrationDetails,
  type AgentRegistrationSummary,
  type SerializedChannel,
  type SerializedSpace,
} from "@xmatrix/protocol";

import { ContentSkeleton, ListSkeleton } from "./content-skeleton";
import { actionClass } from "@/components/ui/action-tone";
import { Button } from "@/components/ui/button";
import { noticeClass } from "@/components/ui/status-tone";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { cn } from "@/lib/utils";

import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { AGENT_USAGE_REFRESH_MS, agentUsageReadings } from "./agent-quota-usage";
import { useNow } from "./agent-work-intent";
import { channelTitle } from "./channel-links";
import { HarnessSignInSection } from "./harness-sign-in";
import { IdentityAvatar } from "./identity-avatar";
import { MachineGlyph } from "./machine-glyph";
import { MeterReadingList } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import {
  MY_AGENT_ACTION_LABEL,
  registrationActions,
  registrationActivity,
  registrationCatalogErrorText,
  registrationListed,
  registrationRowTitle,
  registrationStatus,
  registrationSwitch,
  type MyAgentAction,
} from "./my-agents-registrations";
import { spaceMemberCanCreate } from "./space-member-permissions";
import { ConnectMachine } from "./space-agent-setup-card";
import { ADD_AGENT_ITEM } from "./my-agents-items";
import { formatRelativeAge } from "./time-display";
import { registrationTupleId, useRegistrationCommand } from "./use-registration-command";
import {
  ToolDetail, ToolDetailEmpty, ToolDetailSection, ToolFact, ToolFacts, ToolList, ToolListGroup, ToolListRow, ToolSplit,
  ToolStateDot, useToolItem,
} from "./tool-split";

const ACTION_ICON: Record<MyAgentAction, ComponentType<{ className?: string }>> = {
  configure: Settings,
  restore: RotateCcw,
};

const ACTION_CONSEQUENCE: Record<MyAgentAction, string> = {
  configure: "Name and default model",
  restore: "Offer this agent to the Space again",
};

const INPUT_CLASS =
  "h-9 w-full border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

/**
 * Agents: the Space's registrations under their runtime, one row per location
 * (owner and machine). A row is named by what differs between a runtime's
 * locations and says what that location is doing now.
 */
export function MyAgentsView({
  spaceId,
  token,
  currentUserId,
  currentSpace,
  channels,
  error,
  addsOnThisMachine,
  onOpenAgentCreate,
  onOpenConversation,
}: {
  spaceId: string | null;
  token: string | undefined;
  currentUserId: string;
  currentSpace: SerializedSpace | null;
  /** The Space's conversations the reader has, to name where an agent runs. */
  channels: readonly SerializedChannel[];
  error: string | null;
  /** The desktop app can add an agent on this machine; a browser cannot. */
  addsOnThisMachine: boolean;
  onOpenAgentCreate: () => void;
  onOpenConversation: (channelId: string) => void;
}) {
  const ready = Boolean(spaceId && token);
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", ready, { live: true });
  const command = useRegistrationCommand(spaceId ?? "", token ?? "", () => void catalog.refetch());
  const [editingId, setEditingId] = useState<string | null>(null);
  /* A switch shows its new position at once and holds it until the agent list
     confirms it; waiting for the list's reload made a flip look ignored. */
  const [switching, setSwitching] = useState<{ id: string; on: boolean } | null>(null);
  const [item, select] = useToolItem();

  const canCreateAgent = spaceMemberCanCreate(currentSpace, currentUserId, "agentCreation");

  function act(registration: AgentRegistrationSummary, action: MyAgentAction) {
    const id = registrationTupleId(registration.key);
    if (action === "configure") {
      setEditingId((current) => (current === id ? null : id));
      return;
    }
    void command.run(registration.key, { kind: action });
  }

  const conversationTitle = (channelId: string) => {
    const channel = channels.find((candidate) => candidate.id === channelId);
    return channel ? channelTitle(channel) : undefined;
  };
  // Ticks with the catalog refresh, so ages and reset countdowns keep moving.
  const now = useNow(AGENT_USAGE_REFRESH_MS);
  // Within a runtime, what is working comes first and what cannot work comes last.
  const groups = (catalog.data?.capabilities ?? []).map((group) => ({
    harness: group.harness,
    rows: group.locations.filter(registrationListed).map((registration) => ({
      registration,
      harness: group.harness,
      id: registrationTupleId(registration.key),
      activity: registrationActivity(registration, { conversationTitle, now }),
      ...registrationRowTitle(registration),
    })).sort((left, right) => left.activity.rank - right.activity.rank || left.title.localeCompare(right.title)),
  })).filter((group) => group.rows.length > 0);
  const rows = groups.flatMap((group) => group.rows);
  const chosen = rows.find((row) => row.id === item);
  // A desktop shows the list's first row beside it until another is chosen.
  const shown = chosen ?? (item ? undefined : rows[0]);

  const list = (
    <ToolList title="Agents" createLead="avatar" create={{ label: "New agent", onCreate: onOpenAgentCreate, disabled: !canCreateAgent }}>
      {error && <p role="alert" className="px-4 pb-2 text-xs font-medium text-destructive md:px-5">{error}</p>}
      {!ready ? (
        <p className="px-4 text-sm text-muted-foreground md:px-5">Choose a Space to see the agents registered in it.</p>
      ) : catalog.isError ? (
        <div className="space-y-2 px-4 md:px-5">
          <p role="alert" className="text-sm text-destructive">{registrationCatalogErrorText(catalog.error)}</p>
          <Button size="sm" variant="outline" onClick={() => void catalog.refetch()}>Try again</Button>
        </div>
      ) : !catalog.data ? (
        <ListSkeleton label="Loading agents" rows={4} className="px-4 md:px-5" />
      ) : rows.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground md:px-5">No agents yet.</p>
      ) : groups.map((group) => (
        <ToolListGroup key={group.harness} title={group.harness} count={group.rows.length} identity
          icon={<IdentityAvatar kind="agent" label={group.harness}
            imageUrl={agentPresetAvatarUrl(normalizeAgentPresetRuntime(group.harness))}
            initials={group.harness.slice(0, 2)} size="sm" className="shrink-0" />}>
          {group.rows.map((row) => (
            <ToolListRow key={row.id} testId="agent-row" state={row.activity.state}
              selected={row.id === item}
              shownBeside={!item && shown?.id === row.id}
              onSelect={() => { select(row.id); setEditingId(null); }}
              leading={<span className="app-tool-state-icon" data-state={row.activity.state} aria-hidden="true">
                <MachineGlyph os={machineOs(row.registration.live?.machine.platform)} className="size-4" /></span>}
              title={row.title}
              end={row.registration.key.ownerUserId === currentUserId ? undefined : row.registration.ownerName}
              subtitle={row.machineInLine ? `${row.registration.machineName} · ${row.activity.line}` : row.activity.line} />
          ))}
        </ToolListGroup>
      ))}
    </ToolList>
  );

  let detail: React.ReactNode = null;
  if (shown) {
    const { registration, id, activity, harness, title, machineInLine } = shown;
    const status = registrationStatus(registration);
    const allActions = registrationActions(registration);
    const toggle = registrationSwitch(registration);
    const busy = command.pendingId === id;
    const live = registration.live;
    const seen = formatRelativeAge(live?.machine.lastSeenAt, now);
    const machineState = !live ? null : live.machine.online ? "online" : seen ? `offline, seen ${seen}` : "offline";
    const running = live?.running ?? [];
    const usage = agentUsageReadings(live?.quota, now);
    const checked = formatRelativeAge(live?.quota?.observedAt, now);
    detail = (
      <ToolDetail
        key={id}
        onBack={() => select(null)}
        backLabel="Agents"
        context={<span className="flex items-center gap-1.5">
          <IdentityAvatar kind="agent" label={harness}
            imageUrl={agentPresetAvatarUrl(normalizeAgentPresetRuntime(harness))} initials={harness.slice(0, 2)} size="xs" />
          <span>{machineInLine ? `${harness} · ${registration.machineName}` : harness}</span>
        </span>}
        title={title}
        status={<span className="flex items-center gap-2">
          <ToolStateDot state={activity.state} />
          <span className="text-foreground">{activity.line}</span>
        </span>}
        actions={<>
          {allActions.map((action) => {
            const Icon = busy && action !== "configure" ? Loader2 : ACTION_ICON[action];
            return (
              <Button key={action} size="sm" variant="outline" disabled={busy}
                onClick={() => act(registration, action)}
                aria-label={`${MY_AGENT_ACTION_LABEL[action]}: ${registration.displayName}`}
                aria-expanded={action === "configure" ? editingId === id : undefined}
                title={ACTION_CONSEQUENCE[action]}>
                <Icon className={cn(busy && action !== "configure" && "animate-spin")} />
                {MY_AGENT_ACTION_LABEL[action]}
              </Button>
            );
          })}
          {toggle && (() => {
            const pending = switching?.id === id ? switching : null;
            const on = pending ? pending.on : toggle.on;
            return (
              <label className="flex items-center gap-2 text-sm font-semibold"
                title={on ? "Turning it off stops its running work in this Space" : "Let it take work in this Space"}>
                <Switch checked={on} disabled={busy || Boolean(pending)} label={`Enabled: ${registration.displayName}`}
                  onChange={() => void (async () => {
                    setSwitching({ id, on: !toggle.on });
                    try {
                      for (const kind of toggle.changes) if (!(await command.run(registration.key, { kind }))) return;
                      await catalog.refetch();
                    } finally {
                      setSwitching(null);
                    }
                  })()} />
                {pending ? (pending.on ? "Enabling…" : "Disabling…") : on ? "Enabled" : "Disabled"}
              </label>
            );
          })()}
        </>}
      >
        {command.notice && (
          <p role="status" className={noticeClass(command.notice.error ? "alert" : "settled", "rounded-lg p-3")}>{command.notice.text}</p>
        )}
        {!canCreateAgent && currentSpace ? (
          <p className="text-sm text-muted-foreground">
            Only owners and admins can add agents to {currentSpace.name}. Existing agents remain available.
          </p>
        ) : null}
        {editingId === id && token && (
          <ToolDetailSection title="Settings">
            <RegistrationEditor
              registration={registration}
              token={token}
              busy={busy}
              onCancel={() => setEditingId(null)}
              onSave={async (change) => {
                if (await command.run(registration.key, { kind: "configure", ...change })) setEditingId(null);
              }}
            />
          </ToolDetailSection>
        )}
        {running.length > 0 && (
          <ToolDetailSection title={`Running now · ${running.length}`}>
            <ul className="app-tool-lines">
              {running.map((instance) => {
                const conversation = conversationTitle(instance.channelId);
                const started = formatRelativeAge(instance.since, now);
                return (
                  <li key={instance.instanceId} className="flex min-w-0 items-baseline gap-2 py-1.5 text-sm">
                    {conversation ? (
                      <button type="button" onClick={() => onOpenConversation(instance.channelId)}
                        className="min-w-0 truncate text-left font-semibold hover:underline">
                        #{conversation}
                      </button>
                    ) : <span className="min-w-0 truncate font-semibold">A conversation</span>}
                    <span className="shrink-0 text-muted-foreground">{registration.displayName}:{instance.channelInstanceId}</span>
                    {started && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">started {started}</span>}
                  </li>
                );
              })}
            </ul>
          </ToolDetailSection>
        )}
        {usage.length > 0 && (
          <ToolDetailSection title="Usage">
            <MeterReadingList label={`${registration.displayName} usage`} readings={usage} />
            {checked && (
              <p className="mt-3 text-xs text-muted-foreground" data-testid="agent-usage-checked">
                From the provider, checked {checked}. Updates while this page is open.
              </p>
            )}
          </ToolDetailSection>
        )}
        {token && <HarnessSignInSection registration={registration} token={token} userId={currentUserId} />}
        <ToolDetailSection title="Where it runs">
          <ToolFacts>
            <ToolFact label="Runtime">{harness}</ToolFact>
            <ToolFact label="Machine">{machineState ? `${registration.machineName} · ${machineState}` : registration.machineName}</ToolFact>
            <ToolFact label="Owner">{registration.ownerName}</ToolFact>
            <ToolFact label="In this Space">{status?.label ?? "Ready for new work"}</ToolFact>
          </ToolFacts>
          {running.length === 0 && activity.state === "running" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Not running in any conversation now. Summon it in one with @ and its name.
            </p>
          )}
        </ToolDetailSection>
      </ToolDetail>
    );
  } else if (item === ADD_AGENT_ITEM || (catalog.data && rows.length === 0 && !addsOnThisMachine)) {
    /* A browser cannot start anything on a machine, so New agent here shows
       where agents come from instead of a form it could never save. */
    detail = (
      <ToolDetailEmpty icon={<HardDrive />} title="Bring your agents into xMatrix">
        <p>
          Your agents run on your own computer, and xMatrix connects them with the people they work
          with. Open the desktop app on that computer and it finds the agents already installed there.
        </p>
        <a href="/download" className={actionClass({ variant: "primary", size: "sm" })}>
          <Download className="size-4" /> Download xMatrix
        </a>
        <ConnectMachine spaceId={spaceId} token={token} userId={currentUserId} centered />
      </ToolDetailEmpty>
    );
  } else if (catalog.data && rows.length === 0) {
    detail = (
      <ToolDetailEmpty icon={<Cpu />} title="No agents yet">
        <p>Add an agent with New agent, or from the machine that runs it with xmatrix agent add.</p>
        <Button size="sm" variant="outline" disabled={!canCreateAgent} onClick={onOpenAgentCreate}><Plus /> New agent</Button>
      </ToolDetailEmpty>
    );
  }

  return (
    <div className="app-agents-view flex min-h-0 min-w-0 flex-1">
      <ToolSplit label="Agents" open={Boolean(item)} list={list} detail={detail} />
    </div>
  );
}

/** Edits the Space's own name and default model for one registration, starting
 * from the server's current configuration rather than the catalog summary. */
function RegistrationEditor({
  registration,
  token,
  busy,
  onCancel,
  onSave,
}: {
  registration: AgentRegistrationSummary;
  token: string;
} & RegistrationEditorActions) {
  const { user } = useAuth();
  const details = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "agent-registration-details",
      [registrationTupleId(registration.key)]),
    queryFn: ({ signal }) => xmatrixApiRequest<AgentRegistrationDetails>({
      url: WEB_PROXY_ROUTES.space_agent_registration_query(registration.key.spaceId),
      token, method: "POST", body: registration.key, signal,
    }),
    staleTime: 0,
    retry: false,
  });
  if (details.isError) {
    return <p role="alert" className={noticeClass("alert", "mt-2")}>{details.error.message}</p>;
  }
  if (!details.data) {
    return (
      <ContentSkeleton label="Loading settings" lines={3} className="mt-2" />
    );
  }
  return (
    <RegistrationEditorForm
      initialName={details.data.displayName}
      initialModel={details.data.configuration?.model ?? ""}
      busy={busy}
      onCancel={onCancel}
      onSave={onSave}
    />
  );
}

/** Save and cancel controls shared by the registration editor and its loader. */
type RegistrationEditorActions = {
  busy: boolean;
  onCancel: () => void;
  onSave: (change: { displayName: string; model: string }) => void;
};

function RegistrationEditorForm({
  initialName,
  initialModel,
  busy,
  onCancel,
  onSave,
}: {
  initialName: string;
  initialModel: string;
} & RegistrationEditorActions) {
  const [displayName, setDisplayName] = useState(initialName);
  const [model, setModel] = useState(initialModel);
  return (
    <form
      className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ displayName, model });
      }}
    >
      <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
        Name
        <input
          value={displayName}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setDisplayName(event.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <label className="grid gap-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">
        Default model
        <input
          value={model}
          disabled={busy}
          placeholder="Harness default"
          onChange={(event) => setModel(event.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className={actionClass({ variant: "secondary", size: "md" })}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !displayName.trim()} className={actionClass({ variant: "primary", size: "md" })}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Save
        </button>
      </div>
    </form>
  );
}
