"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import {
  WEB_PROXY_ROUTES,
  AGENT_PRESETS,
  agentAccessModes,
  type AgentRegistrationDetails,
  type AgentRegistrationSummary,
  type AgentWorkingMode,
} from "@xmatrix/protocol";

import { harnessSpaceSwitch } from "./harness-space-switch";
import type { useInstalledHarnesses } from "./use-installed-harnesses";
import { SkeletonBar } from "./content-skeleton";
import type { MachineSummary } from "./workspace-shell-helpers";
import { actionClass } from "@/components/ui/action-tone";
import { Button } from "@/components/ui/button";
import { noticeClass } from "@/components/ui/status-tone";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { cn } from "@/lib/utils";

import { ASK_ACCESS_EFFECT, AgentAccessLines, FULL_ACCESS_EFFECT, chooseHeldAccess } from "./agent-access";
import { AgentHarnessDetail } from "./agent-harness-detail";
import { useViewSelection } from "./url-query-state";
import { agentHarnessSelectionId, type AgentListGroup } from "./agent-list-groups";
import { agentBalanceReadings, agentUsageReadings } from "./agent-quota-usage";
import { HarnessQuotaAccess } from "./harness-quota-access";
import { HarnessSetUpSection, HarnessSignInSection } from "./harness-sign-in";
import { DefaultModelSelect } from "./default-model-select";
import { Face } from "./face";
import { MeterReadingList } from "./machine-load-panel";
import {
  MY_AGENT_ACTION_LABEL,
  registrationActions,
  registrationModelChoices,
  registrationSettingsMode,
  registrationSwitch,
  type MyAgentAction,
} from "./my-agents-registrations";
import { formatRelativeAge } from "./time-display";
import { registrationTupleId, useRegistrationCommand } from "./use-registration-command";
import {
  ToolDetail, ToolDetailSection, ToolFact, ToolFacts, ToolStateDot,
} from "./tool-split";
import { ErrorNotice } from "@/components/ui/error-notice";

const ACTION_ICON: Record<MyAgentAction, LucideIcon> = {
  restore: RotateCcw,
};

const ACTION_CONSEQUENCE: Record<MyAgentAction, string> = {
  restore: "Offer this agent to the Space again",
};

/** What each working mode tells the Agent, in one line. The full text is in
 * `packages/cli-rs/crates/core/prompts/working-mode-*.md`. */
const WORKING_MODE_HINT: Record<AgentWorkingMode, string> = {
  autonomous: "Finishes work by the repository's rules, through merge and release",
  cautious: "Asks before larger changes, merging or releasing",
};

const INPUT_CLASS =
  "h-9 w-full border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";

/**
 * An agent's page. One location (an agent on one machine) reads what the
 * Space has of it: what it works on now, what it has used, its sign-in, its
 * access and its settings; the program itself (version, updates) is on its
 * machine's page, one click away. A runtime's page is what is set on the
 * agent itself, whichever machine it runs on.
 */
export function AgentPaper({
  spaceId,
  token,
  currentUserId,
  chosen,
  group,
  now,
  working,
  fleet,
  conversationTitle,
  machineOf,
  backAlways,
  onBack,
  onRefetch,
  onOpenMachine,
  onOpenConversation,
}: {
  spaceId: string | null;
  token: string | undefined;
  currentUserId: string;
  /** The location the address names, */
  chosen: AgentListGroup["rows"][number] | undefined;
  /** or the runtime it names. */
  group: AgentListGroup | undefined;
  now: number;
  /** The Instances with work in hand; the rest wait for their next message. */
  working: ReadonlySet<string>;
  /** The owner's installed harnesses, whose switch turns a preset on or off in this Space. */
  fleet: ReturnType<typeof useInstalledHarnesses>;
  conversationTitle: (channelId: string) => string | undefined;
  /** The Machine an agent runs on, when this reader's list carries it. */
  machineOf: (registration: AgentRegistrationSummary) => MachineSummary | undefined;
  /** Shown without a list beside it, so its way back shows on a desktop too. */
  backAlways?: boolean;
  /** Back to what the agent was opened from. */
  onBack: () => void;
  onRefetch: () => Promise<unknown>;
  onOpenMachine: (machine: MachineSummary) => void;
  onOpenConversation: (channelId: string) => void;
}) {
  const command = useRegistrationCommand(spaceId ?? "", token ?? "", () => void onRefetch());
  /* A switch shows its new position at once and holds it until the agent list
     confirms it; waiting for the list's reload made a flip look ignored. */
  const [switching, setSwitching] = useState<{ id: string; on: boolean } | null>(null);
  const [, select] = useViewSelection("agents");
  const copy = useOnboardingCopy(spaceId, token, currentUserId);

  if (group) {
    return <AgentHarnessDetail key={group.harness} group={group} token={token} backAlways={backAlways}
      onBack={onBack} onOpenLocation={select} onSaved={onRefetch} />;
  }
  if (!chosen) return null;
  const { registration, id, activity, harness, title, machineInLine } = chosen;
  const harnessName = AGENT_PRESETS.find((preset) => preset.id === harness)?.displayName ?? harness;
  const mine = registration.key.ownerUserId === currentUserId;
  const ownerPreset = mine ? AGENT_PRESETS.find((preset) => preset.id === harness) : undefined;
  const toggle = ownerPreset ? harnessSpaceSwitch(registration) : registrationSwitch(registration);
  const allActions = registrationActions(registration).filter((action) => action !== "restore" || !ownerPreset);
  const settingsMode = registrationSettingsMode(registration);
  const busy = command.pendingId === id || Boolean(fleet.pending) || fleet.enablingAll;
  const live = registration.live;
  const running = live?.running ?? [];
  const usage = [...agentUsageReadings(live?.quota, now), ...agentBalanceReadings(live?.balance)];
  const checked = formatRelativeAge(live?.quota?.observedAt ?? live?.balance?.observedAt, now);
  const machine = machineOf(registration);
  return (
    <ToolDetail
      key={id}
      onBack={onBack}
      backLabel="Agents"
      backAlways={backAlways}
      context={<span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <Face of={{ kind: "agent", name: harness, harness }} size="xs" />
        <button type="button" data-testid="agent-open-harness" title={`What this Space has set on ${harness}, on every machine`}
          className="underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => select(agentHarnessSelectionId(harness))}>{harnessName}</button>
        <span>on</span>
        {machine ? <button type="button" data-testid="agent-open-machine" title="Its machine: what is installed there, and its load"
          className="underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => onOpenMachine(machine)}>{registration.machineName}</button> : <span>{registration.machineName}</span>}
        {!mine && <span>· {registration.ownerName}</span>}
      </span>}
      title={machineInLine ? title : harness}
      status={<span className="flex items-center gap-2">
        <ToolStateDot state={activity.state} />
        <span className="text-foreground">{activity.line}</span>
      </span>}
      actions={allActions.length > 0 || toggle ? <>
        {allActions.map((action) => {
          const Icon = busy ? Loader2 : ACTION_ICON[action];
          return (
            <Button key={action} size="sm" variant="outline" disabled={busy}
              onClick={() => void command.run(registration.key, { kind: action })}
              aria-label={`${MY_AGENT_ACTION_LABEL[action]}: ${registration.displayName}`}
              title={ACTION_CONSEQUENCE[action]}>
              <AnimatedIcon icon={Icon} className={cn(busy && "animate-spin")} />
              {MY_AGENT_ACTION_LABEL[action]}
            </Button>
          );
        })}
        {toggle && (() => {
          const pending = switching?.id === id ? switching : null;
          const on = pending ? pending.on : toggle.on;
          return (
            <label className="flex items-center gap-2 text-sm font-semibold"
              title={on ? "Turning it off stops its running work" : "Let it take work"}>
              <Switch checked={on} disabled={busy || Boolean(pending)} label={`Enabled: ${registration.displayName}`}
                onChange={() => void (async () => {
                  setSwitching({ id, on: !toggle.on });
                  try {
                    if (ownerPreset) {
                      if (!(await fleet.set(registration.key, ownerPreset, !toggle.on))) return;
                    } else {
                      for (const kind of toggle.changes) if (!(await command.run(registration.key, { kind }))) return;
                    }
                    await onRefetch();
                  } finally {
                    setSwitching(null);
                  }
                })()} />
              {pending ? (pending.on ? "Enabling…" : "Disabling…") : on ? "Enabled" : "Disabled"}
            </label>
          );
        })()}
      </> : undefined}
    >
      {fleet.error && <p role="alert" className={noticeClass("alert", "rounded-lg p-3")}>{fleet.error}</p>}
      {command.notice && (
        <p role="status" className={noticeClass(command.notice.error ? "alert" : "settled", "rounded-lg p-3")}>{command.notice.text}</p>
      )}
      {settingsMode !== "none" && token && (
        <ToolDetailSection title="Settings">
          <RegistrationSettings
            key={id}
            registration={registration}
            token={token}
            editable={settingsMode === "edit"}
            busy={busy}
            onSave={(change) => command.run(registration.key, { kind: "configure", ...change })}
          />
        </ToolDetailSection>
      )}
      {running.length > 0 ? (
        <ToolDetailSection title={`In conversations · ${running.length}`}>
          <ul className="app-tool-lines">
            {running.map((instance) => {
              const conversation = conversationTitle(instance.channelId);
              const started = formatRelativeAge(instance.since, now);
              const atWork = working.has(instance.instanceId);
              return (
                <li key={instance.instanceId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 py-1.5 text-sm" data-testid="agent-instance">
                  {conversation ? (
                    <button type="button" onClick={() => onOpenConversation(instance.channelId)}
                      className="max-w-full truncate text-left font-semibold hover:underline">
                      #{conversation}
                    </button>
                  ) : <span className="max-w-full truncate font-semibold">A conversation</span>}
                  <span className="shrink-0 text-muted-foreground">{registration.displayName}:{instance.channelInstanceId}</span>
                  <span className={cn("ml-auto shrink-0 text-xs tabular-nums", atWork ? "font-semibold text-foreground" : "text-muted-foreground")}>
                    {atWork ? "Working" : "Waiting for a message"}{started ? ` · started ${started}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </ToolDetailSection>
      ) : activity.state === "running" && (
        <p className="text-sm text-muted-foreground">
          In no conversation now. Summon it in one with @ and its name.
        </p>
      )}
      {usage.length > 0 && (
        <ToolDetailSection title="Usage">
          <MeterReadingList label={`${registration.displayName} usage`} readings={usage} />
          {checked && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="agent-usage-checked">
              From the provider, checked {checked}. Updates while this page is open.
            </p>
          )}
          {token && <div className="mt-3"><HarnessQuotaAccess bare hasReading target={registration} token={token}
            userId={currentUserId} onChanged={() => void onRefetch()} /></div>}
        </ToolDetailSection>
      )}
      {usage.length === 0 && token && <HarnessQuotaAccess target={registration} token={token} userId={currentUserId}
        onChanged={() => void onRefetch()} />}
      {token && <HarnessSignInSection registration={registration} token={token} userId={currentUserId} />}
      {token && <HarnessSetUpSection registration={registration} token={token} userId={currentUserId} copy={copy} />}
      {registration.access && (
        <ToolDetailSection title={registration.access.mode === "full" ? "Full access on its machine" : "Asks before it acts on its machine"}>
          <div className="space-y-2 text-sm" data-testid="agent-access">
            {registration.access.mode === "full" ? <>
              <p>xMatrix starts {harnessName} like this:</p>
              <AgentAccessLines grant={registration.access} name={harnessName} />
              <p className="text-xs text-muted-foreground">{FULL_ACCESS_EFFECT}</p>
            </> : <p>{ASK_ACCESS_EFFECT}</p>}
            {/* Added before its owner was asked, it runs as it always did until they read this
                and confirm; once confirmed, its owner changes the mode here. */}
            {registration.canManageOwnerGrant && token
              ? (!registration.access.confirmed || agentAccessModes(AGENT_PRESETS.find((preset) => preset.id === harness)).length > 1) && (
                <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
                  const mode = await chooseHeldAccess(token, registration.key, harnessName);
                  if (mode && (mode !== registration.access?.mode || !registration.access.confirmed)) {
                    void command.run(registration.key, { kind: "access", mode });
                  }
                }}>{registration.access.confirmed ? "Change" : "Review and confirm"}</Button>
              ) : !registration.access.confirmed && <p className="text-xs text-muted-foreground">Its owner has not confirmed this yet.</p>}
          </div>
        </ToolDetailSection>
      )}
    </ToolDetail>
  );
}

type RegistrationSettingsValues = {
  displayName: string;
  model: string;
  workingMode: AgentWorkingMode;
  instructions: string;
};

/** Space settings for one registration, read directly from the server and
 * edited in place by Space owners and admins. */
function RegistrationSettings({
  registration,
  token,
  editable,
  busy,
  onSave,
}: {
  registration: AgentRegistrationSummary;
  token: string;
  editable: boolean;
  busy: boolean;
  onSave: (change: RegistrationSettingsValues) => Promise<boolean>;
}) {
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
    return <ErrorNotice error={details.error} action="Couldn't load this agent" className={noticeClass("alert", "mt-2")}
      onRetry={() => void details.refetch()} />;
  }
  if (!details.data) {
    return (
      <div className="app-skeleton-inert mt-3 space-y-3" role="status" aria-label="Loading settings">
        <div aria-hidden="true">
          <ToolFacts>
            <ToolFact label="Name"><SkeletonBar width="7rem" /></ToolFact>
            <ToolFact label="Default model"><SkeletonBar width="9rem" /></ToolFact>
            <ToolFact label="Working mode"><SkeletonBar width="5.5rem" /></ToolFact>
          </ToolFacts>
          <div className="mt-3 space-y-1 text-sm">
            <p className="text-muted-foreground">Instructions</p>
            <p><SkeletonBar width="65%" /></p>
          </div>
        </div>
      </div>
    );
  }
  const server: RegistrationSettingsValues = {
    displayName: details.data.displayName,
    model: details.data.configuration?.model ?? "",
    workingMode: details.data.configuration?.workingMode ?? "autonomous",
    instructions: details.data.configuration?.instructions ?? "",
  };
  if (!editable) {
    return (
      <div className="mt-3 space-y-3" data-testid="agent-settings-readonly">
        <ToolFacts>
          <ToolFact label="Name">{server.displayName}</ToolFact>
          <ToolFact label="Default model">
            {server.model || <span className="text-muted-foreground">Harness default</span>}
          </ToolFact>
          <ToolFact label="Working mode">
            {server.workingMode === "cautious" ? "Cautious" : "Autonomous"}
          </ToolFact>
        </ToolFacts>
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">Instructions</p>
          {server.instructions ? (
            <p className="whitespace-pre-wrap break-words">{server.instructions}</p>
          ) : (
            <p className="text-muted-foreground">None</p>
          )}
        </div>
      </div>
    );
  }
  return (
    <RegistrationSettingsForm
      server={server}
      modelChoices={registrationModelChoices(registration, server.model)}
      busy={busy}
      onSave={async (change) => {
        if (!(await onSave(change))) return false;
        await details.refetch();
        return true;
      }}
    />
  );
}

function RegistrationSettingsForm({
  server,
  modelChoices,
  busy,
  onSave,
}: {
  server: RegistrationSettingsValues;
  modelChoices: ReadonlyArray<{ model: string; description?: string }>;
  busy: boolean;
  onSave: (change: RegistrationSettingsValues) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<RegistrationSettingsValues | null>(null);
  const value = draft ?? server;
  const update = (patch: Partial<RegistrationSettingsValues>) =>
    setDraft((current) => ({ ...(current ?? server), ...patch }));
  const changed = draft !== null && (
    draft.displayName.trim() !== server.displayName.trim()
    || draft.model.trim() !== server.model.trim()
    || draft.workingMode !== server.workingMode
    || draft.instructions.trim() !== server.instructions.trim()
  );
  return (
    <form
      className="mt-3 grid items-start gap-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || busy || !value.displayName.trim()) return;
        void (async () => {
          if (await onSave(value)) setDraft(null);
        })();
      }}
    >
      <label className="grid gap-1.5 text-[13px] font-semibold">
        Name
        <input
          value={value.displayName}
          maxLength={80}
          disabled={busy}
          onChange={(event) => update({ displayName: event.target.value })}
          className={INPUT_CLASS}
        />
      </label>
      <label className="grid gap-1.5 text-[13px] font-semibold">
        Default model
        <DefaultModelSelect
          value={value.model}
          choices={modelChoices}
          disabled={busy}
          onChange={(model) => update({ model })}
          className={INPUT_CLASS}
          inputClassName={`${INPUT_CLASS} font-normal`}
        />
      </label>
      <label className="grid gap-1.5 text-[13px] font-semibold">
        Working mode
        <select
          value={value.workingMode}
          disabled={busy}
          title={WORKING_MODE_HINT[value.workingMode]}
          onChange={(event) => update({ workingMode: event.target.value as AgentWorkingMode })}
          className={INPUT_CLASS}
        >
          <option value="autonomous">Autonomous</option>
          <option value="cautious">Cautious</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-[13px] font-semibold sm:col-span-3">
        Instructions
        <textarea
          value={value.instructions}
          disabled={busy}
          rows={4}
          placeholder="What this Agent should always do, in this Space"
          onChange={(event) => update({ instructions: event.target.value })}
          className={`${INPUT_CLASS} h-auto py-2 normal-case tracking-normal font-normal`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {WORKING_MODE_HINT[value.workingMode]}
        </p>
        {changed && (
          <>
            <button type="button" disabled={busy} onClick={() => setDraft(null)} className={actionClass({ variant: "secondary", size: "sm" })}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !value.displayName.trim()} className={actionClass({ variant: "primary", size: "sm" })}>
              {busy ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
              Save
            </button>
          </>
        )}
      </div>
    </form>
  );
}
