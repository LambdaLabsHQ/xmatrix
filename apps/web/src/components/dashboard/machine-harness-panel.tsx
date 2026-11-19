"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HARNESS_ACTION_SETTLE_MS, harnessCommandLabel, harnessTooOld, type AgentPreset, type HarnessAction, type HarnessActionStatus, type SerializedMachineDaemon } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { statusInkClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { harnessSpaceKey, harnessSpaceSwitch,
  harnessTurnsOnAfterInstall } from "./harness-space-switch";
import { useHarnessSpaceControl } from "./use-harness-space-control";
import { fetchMachineDaemons } from "./workspace-admin-views";
import { queueHarnessAction, readHarnessAction, readRecentHarnessActions, refreshHarnessInventory } from "./machine-harness-api";
import { HARNESS_ACTION_LABELS, describeHarnessAction } from "./machine-harness-action-status";
import { harnessAutoUpdateSupported, harnessUpdateAvailable, machineHarnessState } from "./machine-harness-state";
import { UserFacingProblem, userErrorMessage } from "@/lib/user-facing-error";
import { Face } from "./face";
import { HarnessSignInSection } from "./harness-sign-in";
import { MachineLoadGlanceBars } from "./machine-load-panel";
import type { ToolState } from "./tool-split";

type HarnessRowState = ReturnType<typeof machineHarnessState>["rows"][number];
type Operation = { controlId: string; action: HarnessAction; requestedHere?: boolean; label: string; startedAt: number };
const SETTLED = (status?: HarnessActionStatus["status"]) => Boolean(status && !["queued", "running"].includes(status));
/** Follow an action a little past the point where Hub settles one its daemon stopped answering. */
const FOLLOW_MS = HARNESS_ACTION_SETTLE_MS + 60_000;

function operationFrom(status: HarnessActionStatus, displayName: string): Operation {
  const requested = status.requestedAt ? Date.parse(status.requestedAt) : NaN;
  return { controlId: status.controlId, action: status.action, label: `${HARNESS_ACTION_LABELS[status.action]}${status.action === "refresh" ? "" : ` · ${displayName}`}`,
    startedAt: Number.isFinite(requested) ? requested : Date.now() };
}

/** One harness action and its status, followed until it settles. Each row
 * (and Refresh) holds its own, because the daemon runs actions on different
 * harnesses side by side and refuses only a second one on the same harness:
 * updating Claude Code must not stop the other rows. Until this page starts
 * one, a row shows the latest action Hub recorded for it, so leaving and
 * coming back never loses what became of an install. */
function useHarnessOperation({ token, userId, daemonKey, current, canManage, onNotice }: {
  token?: string | null; userId: string; daemonKey: readonly unknown[];
  current?: SerializedMachineDaemon; canManage: boolean; onNotice: (notice: string | null) => void;
}, recorded?: HarnessActionStatus, displayName = "") {
  const queryClient = useQueryClient();
  const [started, setOperation] = useState<Operation | null>(null);
  const operation = useMemo(() => started ?? (recorded ? operationFrom(recorded, displayName) : null),
    [started, recorded, displayName]);
  const status = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId }, "harness-actions", [operation?.controlId ?? null]),
    queryFn: ({ signal }) => readHarnessAction(token!, operation!.controlId, signal),
    enabled: Boolean(token && operation), retry: false,
    ...(recorded && operation?.controlId === recorded.controlId ? { initialData: recorded } : {}),
    staleTime: 2_000,
    refetchInterval: (query) => operation && Date.now() - operation.startedAt < FOLLOW_MS &&
      !SETTLED(query.state.data?.status) ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const pending = Boolean(operation && !SETTLED(status.data?.status) && Date.now() - operation.startedAt < FOLLOW_MS);
  const settledByThisPage = Boolean(started && SETTLED(status.data?.status));
  useEffect(() => {
    if (settledByThisPage) void queryClient.invalidateQueries({ queryKey: daemonKey });
  }, [settledByThisPage, operation?.controlId, queryClient, daemonKey]);
  const action = useMutation({
    mutationFn: async (input: { presetId: string; action: HarnessAction }) => {
      if (!token || !current?.machineId || !canManage) throw new UserFacingProblem("This machine cannot be managed right now.");
      return input.action === "refresh"
        ? refreshHarnessInventory(token, current.machineId, current.hostId)
        : queueHarnessAction(token, current.machineId, current.hostId, input.presetId, input.action);
    },
    onSuccess: (result, input) => {
      setOperation({ controlId: result.controlId, action: input.action, requestedHere: true, label: `${HARNESS_ACTION_LABELS[input.action]}${input.action === "refresh" ? "" : ` · ${displayName || input.presetId}`}`, startedAt: Date.now() });
      onNotice(null);
    },
    onError: (error) => onNotice(userErrorMessage(error, "Couldn't send that to the machine")),
  });
  return { operation, status, busy: pending || action.isPending, run: action.mutate };
}

type SpaceSwitches = ReturnType<typeof useHarnessSpaceSwitches>;

function useHarnessSpaceSwitches({ token, spaceId, current, userId }: {
  token?: string | null; spaceId?: string; current?: SerializedMachineDaemon; userId?: string;
}) {
  const control = useHarnessSpaceControl(spaceId, token, userId);
  const owner = Boolean(spaceId && token && userId && current?.machineId && current.userId === userId);
  const keyFor = (presetId: string) => harnessSpaceKey(spaceId!, userId!, current!.machineId!, presetId);
  return { owner, ready: owner && control.ready, error: control.error, isBusy: control.isBusy,
    pending: control.pending ? { presetId: control.pending.key.harness, on: control.pending.on } : null,
    registrationFor: (presetId: string) => owner ? control.registrationFor(keyFor(presetId)) : undefined,
    set: (preset: AgentPreset, on: boolean) => owner ? control.set(keyFor(preset.id), preset, on) : Promise.resolve(false) };
}

function OperationStatus({ operation, status, displayName, responding }: {
  operation: Operation; status: ReturnType<typeof useHarnessOperation>["status"]; displayName: string; responding: boolean;
}) {
  const described = describeHarnessAction(status.data, { displayName, now: Date.now(), requestedAt: operation.startedAt });
  const when = status.data?.completedAt ?? status.data?.requestedAt;
  return <div aria-live="polite" className="mt-1 space-y-1">
    <p className={statusInkClass(described.tone === "error" ? "alert" : described.tone === "warning" ? "attention" : "settled")}>
      {operation.label}: {described.text}
      {when && described.tone !== "pending" && <span className="text-muted-foreground"> · {new Date(when).toLocaleString()}</span>}</p>
    {!responding && !SETTLED(status.data?.status) && <p className={statusInkClass("attention")}>
      The machine is not responding, so this action may not have been delivered.</p>}
    {status.data?.error && <p className="text-destructive">{status.data.error}</p>}
    {status.isError && <><p className="text-destructive">Status could not be checked. The operation may still be running.</p>
      <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>Check status</Button></>}
    {status.data?.result?.outputTail && <details><summary>Command output</summary>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{status.data.result.outputTail.slice(-4096)}</pre>
    </details>}
  </div>;
}

/** What an agent on this Machine does in this Space, as its row in the list says it. */
export type MachineAgentGlance = {
  state: ToolState;
  line: string;
  usage: readonly { key: string; label: string; percent: number; detail?: string }[];
};

/**
 * The agents on one Machine. Each installed one is a line: what it does in
 * this Space, the step it waits on (sign in), and its switch for this Space;
 * its upkeep (version, updates, uninstall) opens under it. What is not
 * installed yet is offered under "Add an agent" and joins the lines above
 * once installed, so installing, signing in and turning on happen in one place.
 */
export function MachineHarnessPanel({ daemon, token, spaceId, agentOn, onOpenAgent, only, onOperation }: {
  daemon?: SerializedMachineDaemon; token?: string | null;
  /** The Space being viewed, whose switches the owner sees beside each installed agent. */
  spaceId?: string;
  /** The agent a program runs as in this Space, when the Space lists one. */
  agentOn?: (harness: string) => MachineAgentGlance | undefined;
  /** Opens that agent: its work, usage and settings. */
  onOpenAgent?: (harness: string) => void;
  /** Just this agent's line, with its upkeep open: one cell of the matrix, edited in place. */
  only?: string;
  /** What is being done to that agent on the Machine now, or null once nothing is: its cell says it meanwhile. */
  onOperation?: (action: HarnessAction | null) => void;
}) {
  const { user } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);
  const userId = user?.id ?? "anonymous";
  const daemonKey = useMemo(() => xmatrixQueryKeys.domain({ userId }, "machine-daemons", []), [userId]);
  const daemons = useQuery({ queryKey: daemonKey,
    queryFn: ({ signal }) => fetchMachineDaemons(token!, signal), enabled: Boolean(token && daemon),
    staleTime: 15_000, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const current = daemons.data ? daemons.data.find((item) => item.id === daemon?.id) : daemon;
  const state = machineHarnessState(current, user?.id);
  const context = { token, userId, daemonKey, current, canManage: state.canManage, onNotice: setNotice };
  // What Hub recorded for this Machine's agents, so a reload shows how earlier actions ended.
  const recentKey = xmatrixQueryKeys.domain({ userId }, "harness-actions-recent", [current?.machineId ?? null]);
  const recent = useQuery({ queryKey: recentKey,
    queryFn: ({ signal }) => readRecentHarnessActions(token!, current!.machineId!, signal),
    enabled: Boolean(token && current?.machineId && current.userId === user?.id), staleTime: 60_000 });
  const recorded = (presetId: string) => recent.data?.find((action) => action.presetId === presetId);
  const refresh = useHarnessOperation(context, recorded("custom"));
  const spaceSwitches = useHarnessSpaceSwitches({ token, spaceId, current, userId: user?.id });

  const installed = state.rows.filter((row) => row.item?.installed);
  const installable = state.rows.filter((row) => !row.item?.installed);
  // With nothing installed the list of what can be is the whole of this section.
  const [adding, setAdding] = useState<boolean | null>(null);
  const addOpen = adding ?? installed.length === 0;
  // A row an action was started on stays, wherever its program ends up listed.
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const touch = (presetId: string) => setTouched((seen) => seen.has(presetId) ? seen : new Set(seen).add(presetId));
  // An install that ended without the program being found still has something to say.
  const offered = installable.filter((row) => addOpen || touched.has(row.preset.id) || recorded(row.preset.id)?.action === "install");
  const row = (entry: HarnessRowState) => <HarnessRow key={entry.preset.id} row={entry} state={state} context={context}
    spaceSwitches={spaceSwitches} recorded={recorded(entry.preset.id)} agent={agentOn?.(entry.preset.id)}
    onOpenAgent={onOpenAgent} onTouched={touch} single={Boolean(only)} onOperation={only ? onOperation : undefined} />;
  const one = only ? state.rows.find((entry) => entry.preset.id === only) : undefined;

  return <div className="space-y-2" data-testid="machine-harness-panel">
    {state.canManage && !state.responding && <p className={statusInkClass("attention", "text-xs")}>
      {`This machine is not responding: work sent to it at ${new Date(current!.unansweredSince!).toLocaleString()} `
        + "is still waiting. Its connection to xMatrix may be unstable, so a new action may not reach it."}</p>}
    {!state.canManage && <p className={statusInkClass("secondary", "text-xs")}>{current?.status !== "online"
      ? "Connect this machine to manage its agents."
      : current?.userId !== user?.id ? "Only this machine's owner can manage its agents."
        : "Update xMatrix on this machine to manage its agents from here."}</p>}
    {notice && <p role="alert" className="text-sm text-destructive">{notice}</p>}
    {spaceSwitches.error && <p role="alert" className="text-sm text-destructive">{spaceSwitches.error}</p>}
    {daemons.isError && <p role="alert" className="text-xs text-destructive">This machine&apos;s agents could not be read again. Showing what it last reported.</p>}
    {only && <ul>{one && row(one)}</ul>}
    {!only && installed.length === 0 && state.inventory && <p className="text-sm text-muted-foreground">No agent is installed on this machine yet.</p>}
    {/* One list, so a program keeps its row, and what its row is doing, as it goes from offered to installed. */}
    {!only && <ul className="app-tool-lines">
      {installed.map(row)}
      {installable.length > 0 && <li>
        <button type="button" aria-expanded={addOpen} data-testid="harness-add"
          className="flex w-full items-center gap-2 py-2.5 text-left text-sm font-semibold text-muted-foreground hover:text-foreground"
          onClick={() => setAdding(!addOpen)}>
          <Plus className="size-4 shrink-0" aria-hidden="true" />Add an agent
          <ChevronDown aria-hidden="true" className={cn("ml-auto size-4 shrink-0 transition-transform", !addOpen && "-rotate-90")} />
        </button>
      </li>}
      {offered.map(row)}
    </ul>}
    {!only && <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      <p className="text-xs text-muted-foreground">{state.inventory
        ? `Checked ${new Date(state.inventory.capturedAt).toLocaleString()}` : "This machine has not reported its agents yet."}</p>
      <Button size="xs" variant="ghost" disabled={!state.canManage || refresh.busy}
        onClick={() => refresh.run({ presetId: "custom", action: "refresh" })}>Refresh</Button>
    </div>}
    {!only && refresh.operation && (refresh.operation.requestedHere || refresh.busy) && <div className="text-sm">
      <OperationStatus operation={refresh.operation} status={refresh.status} displayName="" responding={state.responding} /></div>}
  </div>;
}

function HarnessRow({ row: { preset, item }, state, context, spaceSwitches, recorded, agent, onOpenAgent, onTouched, single, onOperation }: {
  row: HarnessRowState; state: ReturnType<typeof machineHarnessState>;
  context: Parameters<typeof useHarnessOperation>[0]; spaceSwitches: SpaceSwitches; recorded?: HarnessActionStatus;
  agent?: MachineAgentGlance; onOpenAgent?: (harness: string) => void; onTouched: (presetId: string) => void;
  /** The only line shown: its upkeep is open and stays open. */
  single?: boolean;
  onOperation?: (action: HarnessAction | null) => void;
}) {
  const [armed, setArmed] = useState(false);
  const [unfolded, setOpen] = useState(false);
  const open = unfolded || Boolean(single);
  const { operation, status, busy, run } = useHarnessOperation(context, recorded, preset.displayName);
  const doing = busy && operation ? operation.action : null;
  const report = useRef(onOperation);
  useEffect(() => { report.current = onOperation; });
  useEffect(() => {
    report.current?.(doing);
    return () => { if (doing) report.current?.(null); };
  }, [doing]);
  const registration = spaceSwitches.registrationFor(preset.id);
  const installed = Boolean(item?.installed);
  const spaceSwitch = spaceSwitches.ready && installed ? harnessSpaceSwitch(registration) : null;
  const spacePending = spaceSwitches.pending?.presetId === preset.id ? spaceSwitches.pending : null;
  // Installed from here, it is turned on in this Space once.
  const turnedOn = useRef<string | null>(null);
  useEffect(() => {
    if (!operation?.requestedHere || spaceSwitches.isBusy() || !spaceSwitches.ready || turnedOn.current === operation.controlId) return;
    if (!harnessTurnsOnAfterInstall(registration, { action: operation.action, status: status.data?.status,
      installed: status.data?.result?.item?.installed })) return;
    turnedOn.current = operation.controlId;
    void spaceSwitches.set(preset, true);
  }, [operation, status.data, spaceSwitches, registration, preset]);
  const install = state.recipePlatform && preset.management?.install[state.recipePlatform];
  const update = state.recipePlatform && preset.management?.update[state.recipePlatform];
  const uninstall = installed && state.recipePlatform && preset.management?.uninstall[state.recipePlatform];
  const autoSupported = harnessAutoUpdateSupported(preset);
  const autoState = item?.autoUpdate ?? "unknown";
  const cursorUpdateBlocked = preset.id === "cursor" && installed && !state.cursorUpdateReady;
  const updateAvailable = harnessUpdateAvailable(item?.version, item?.latestVersion);
  // xMatrix sends no work to a program older than it can drive: updating it is the next step.
  const tooOld = installed ? harnessTooOld(preset.management, item?.version) : undefined;
  const act = (action: HarnessAction) => { setArmed(false); onTouched(preset.id); run({ presetId: preset.id, action }); };
  // Installed is not yet able to work: its owner signs the program in on this Machine, from this row.
  const machine = context.current;
  const signedOut = installed && item?.login === "signed_out";
  const signIn = signedOut && spaceSwitches.owner && context.token && machine?.machineId && preset.management?.login
    ? { machineName: machine.machineName ?? machine.name, key: { ownerUserId: context.userId, machineId: machine.machineId, harness: preset.id } }
    : null;
  // Listed in this Space, it is an agent with a page of its own: what it works on, its usage, its settings.
  const opens = Boolean(onOpenAgent && agent);
  const described = operation ? describeHarnessAction(status.data, { displayName: preset.displayName, now: Date.now(),
    requestedAt: operation.startedAt }) : null;
  // What an action did is read where it was asked for; one that went wrong is read without being asked.
  const showOperation = Boolean(operation && (operation.requestedHere || busy || open || !installed
    || described?.tone === "error" || described?.tone === "warning"));
  const on = spacePending ? spacePending.on : spaceSwitch?.on;
  const line = !installed ? (item?.probeStatus === "unsupported" ? "Not available on this machine" : null)
    : tooOld ? `Too old for xMatrix, which needs ${tooOld.minimumVersion} or later`
      : signedOut ? "Not signed in"
        : spaceSwitch && !on ? "Off in this Space"
        : agent ? agent.line
          // The Space asked for it and its owner has not answered: that answer is not this switch.
          : spaceSwitches.owner && spaceSwitches.ready && !spaceSwitch ? "Sharing request pending" : "Installed";
  const attention = Boolean(tooOld) || signedOut || (installed && (spaceSwitch ? Boolean(on) : true) && agent?.state === "attention");
  const name = <span className="truncate font-semibold">{preset.displayName}</span>;
  return <li data-testid="harness-row" data-harness={preset.id} className={cn("text-sm", single ? "py-0.5" : "py-2.5")}>
    <div className="flex min-w-0 items-center gap-3">
      <span className={cn("shrink-0", installed && spaceSwitch && !on && "opacity-50")}>
        <Face of={{ kind: "agent", name: preset.id, harness: preset.id }} size="sm" showKindBadge={false} /></span>
      <div className="min-w-0 flex-1">
        {opens ? <button type="button" data-testid="harness-open-agent" title={`Open ${preset.displayName} on this machine`}
          className="block max-w-full truncate text-left underline-offset-2 hover:underline" onClick={() => onOpenAgent!(preset.id)}>{name}</button>
          : <span className="block truncate">{name}</span>}
        {line && <p className={cn("truncate text-xs", attention ? statusInkClass("attention") : "text-muted-foreground")} data-testid="harness-state">
          {line}{installed && !tooOld && updateAvailable && autoState !== "enabled" ? ` · ${item!.latestVersion} available` : ""}</p>}
      </div>
      {installed && spaceSwitch?.on && agent && agent.usage.length > 0 && <span className="hidden shrink-0 sm:block">
        <MachineLoadGlanceBars glance={agent.usage} testId="harness-usage-glance"
          label={agent.usage.map((reading) => reading.detail).join(", ")} /></span>}
      {!installed && item?.probeStatus !== "unsupported" && <Button size="sm" variant="outline"
        disabled={!state.canManage || busy || !item || !install}
        title={install ? harnessCommandLabel(install) : undefined} onClick={() => act("install")}>Install</Button>}
      {tooOld && <Button size="sm" variant="outline" disabled={!state.canManage || busy || cursorUpdateBlocked || !update}
        title={update ? harnessCommandLabel(update) : undefined} onClick={() => act("update")}>Update</Button>}
      {spaceSwitch && <span className="inline-flex shrink-0 items-center" title={on ? "Turning it off stops its running work" : "Let it take work in this Space"}>
        <Switch checked={Boolean(on)} disabled={Boolean(spaceSwitches.pending)}
          label={`Enabled: ${preset.displayName}`} onChange={(next) => void spaceSwitches.set(preset, next)} />
      </span>}
      {installed && !single && <button type="button" aria-expanded={open} aria-label={`Manage ${preset.displayName}`} title="Version, updates, uninstall"
        className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => { setOpen(!open); setArmed(false); }}>
        <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", !open && "-rotate-90")} />
      </button>}
    </div>
    <div className="space-y-2 pl-11 empty:hidden">
      {spacePending && <p className="mt-1 text-xs text-muted-foreground">{spacePending.on ? "Turning on…" : "Turning off…"}</p>}
      {signIn && <div className="mt-2" data-testid="harness-row-sign-in">
        <HarnessSignInSection bare registration={signIn} token={context.token!} userId={context.userId} />
      </div>}
      {signedOut && !signIn && spaceSwitches.owner && <p className="mt-1 text-xs text-muted-foreground">
        {item?.loginDetail ?? "Sign it in on the machine itself, then refresh."}</p>}
      {installed && open && <div className="mt-2 space-y-2 text-xs" data-testid="harness-upkeep">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-muted-foreground">Version</span>
          <span className="[overflow-wrap:anywhere]">{item?.version ?? "Installed"}</span>
          {updateAvailable && <span className="text-muted-foreground">{item!.latestVersion} available</span>}
          <Button size="xs" variant="outline" disabled={!state.canManage || busy || cursorUpdateBlocked || !update}
            title={update ? harnessCommandLabel(update) : undefined} onClick={() => act("update")}>Update</Button>
          {uninstall && <Button size="xs" variant={armed ? "destructive" : "ghost"} disabled={!state.canManage || busy || !state.uninstallReady}
            title={harnessCommandLabel(uninstall)} onBlur={() => setArmed(false)}
            onClick={() => armed ? act("uninstall") : setArmed(true)}>
            {armed ? "Confirm uninstall" : "Uninstall"}</Button>}
        </div>
        {autoSupported && <label className="flex items-center gap-2">
          <Switch checked={autoState === "enabled"} disabled={!state.canManage || busy}
            label={`Automatic updates: ${preset.displayName}`}
            onChange={(next) => act(next ? "auto_update_on" : "auto_update_off")} />
          <span className="text-muted-foreground">Automatic updates</span>
          {autoState === "unknown" && <span className="text-muted-foreground">Unknown</span>}
        </label>}
        {armed && <p className="text-muted-foreground">Settings and sessions are kept. Running instances may stop working.</p>}
        {cursorUpdateBlocked && <p className="text-muted-foreground">Update this machine&apos;s daemon before updating Cursor.</p>}
        {uninstall && state.canManage && !state.uninstallReady && <p className="text-muted-foreground">Update this machine&apos;s daemon to uninstall.</p>}
      </div>}
      {showOperation && <div className="text-xs"><OperationStatus operation={operation!} status={status} displayName={preset.displayName}
        responding={state.responding} /></div>}
    </div>
  </li>;
}
