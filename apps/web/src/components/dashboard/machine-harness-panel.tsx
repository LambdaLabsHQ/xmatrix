"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HARNESS_ACTION_SETTLE_MS, type AgentPreset, type HarnessAction, type HarnessActionStatus, type SerializedMachineDaemon } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { statusInkClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { harnessSpaceKey, harnessSpaceSwitch,
  harnessTurnsOnAfterInstall } from "./harness-space-switch";
import { useHarnessSpaceControl } from "./use-harness-space-control";
import { fetchMachineDaemons } from "./workspace-admin-views";
import { queueHarnessAction, readHarnessAction, readRecentHarnessActions, refreshHarnessInventory } from "./machine-harness-api";
import { HARNESS_ACTION_LABELS, describeHarnessAction } from "./machine-harness-action-status";
import { harnessAutoUpdateSupported, harnessCommandLabel, harnessUpdateAvailable, machineHarnessState } from "./machine-harness-state";
import { UserFacingProblem, userErrorMessage } from "@/lib/user-facing-error";

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

export function MachineHarnessPanel({ daemon, token, spaceId }: {
  daemon?: SerializedMachineDaemon; token?: string | null;
  /** The Space being viewed, whose switches the owner sees beside each installed harness. */
  spaceId?: string;
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
  // What Hub recorded for this Machine's harnesses, so a reload shows how earlier actions ended.
  const recentKey = xmatrixQueryKeys.domain({ userId }, "harness-actions-recent", [current?.machineId ?? null]);
  const recent = useQuery({ queryKey: recentKey,
    queryFn: ({ signal }) => readRecentHarnessActions(token!, current!.machineId!, signal),
    enabled: Boolean(token && current?.machineId && current.userId === user?.id), staleTime: 60_000 });
  const recorded = (presetId: string) => recent.data?.find((action) => action.presetId === presetId);
  const refresh = useHarnessOperation(context, recorded("custom"));
  const spaceSwitches = useHarnessSpaceSwitches({ token, spaceId, current, userId: user?.id });

  return <div className="space-y-3" data-testid="machine-harness-panel">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">{state.inventory
        ? `Last checked ${new Date(state.inventory.capturedAt).toLocaleString()}` : "No harness inventory reported yet."}</p>
      <Button size="sm" variant="outline" disabled={!state.canManage || refresh.busy}
        onClick={() => refresh.run({ presetId: "custom", action: "refresh" })}>Refresh</Button>
    </div>
    {state.canManage && !state.responding && <p className={statusInkClass("attention", "text-xs")}>
      {`This machine is not responding: work sent to it at ${new Date(current!.unansweredSince!).toLocaleString()} `
        + "is still waiting. Its connection to xMatrix may be unstable, so a new action may not reach it."}</p>}
    {!state.canManage && <p className={statusInkClass("secondary", "text-xs")}>{current?.status !== "online"
      ? "Connect this machine to refresh or manage harnesses."
      : current?.userId !== user?.id ? "Only the machine owner can manage harnesses."
        : "Update this machine's daemon to enable harness management."}</p>}
    {notice && <p role="alert" className="text-sm text-destructive">{notice}</p>}
    {spaceSwitches.error && <p role="alert" className="text-sm text-destructive">{spaceSwitches.error}</p>}
    {daemons.isError && <p role="alert" className="text-xs text-destructive">Inventory could not be refreshed. Showing the last reported observation.</p>}
    {refresh.operation && <div className="text-sm"><OperationStatus operation={refresh.operation} status={refresh.status}
      displayName="" responding={state.responding} /></div>}
    <div><table className="block w-full text-left text-xs sm:table">
      <thead className="hidden sm:table-header-group"><tr className="border-b text-muted-foreground"><th className="py-2 pr-3">Harness</th><th className="pr-3">Installed version</th>
        <th className="pr-3">Latest</th><th className="pr-3">Automatic updates</th>
        {spaceSwitches.owner && <th className="pr-3">Enabled</th>}<th>Actions</th></tr></thead>
      <tbody className="block sm:table-row-group">{state.rows.map((row, index) => {
        const beforeDivider = Boolean(row.item?.installed) && index + 1 < state.rows.length && !state.rows[index + 1]?.item?.installed;
        return <Fragment key={row.preset.id}>
          <HarnessRow row={row} state={state} context={context} spaceSwitches={spaceSwitches} recorded={recorded(row.preset.id)} beforeDivider={beforeDivider} />
          {beforeDivider && <HarnessInstallDivider columns={spaceSwitches.owner ? 6 : 5} />}
        </Fragment>;
      })}</tbody>
    </table></div>
  </div>;
}

function HarnessInstallDivider({ columns }: { columns: number }) {
  return <tr data-testid="harness-install-divider" role="separator" aria-hidden="true" className="block sm:table-row">
    <td colSpan={columns} className="block px-0 py-2 sm:table-cell"><div className="h-px bg-border" /></td>
  </tr>;
}

function HarnessRow({ row: { preset, item }, state, context, spaceSwitches, recorded, beforeDivider = false }: {
  row: HarnessRowState; state: ReturnType<typeof machineHarnessState>;
  context: Parameters<typeof useHarnessOperation>[0]; spaceSwitches: SpaceSwitches; recorded?: HarnessActionStatus; beforeDivider?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const { operation, status, busy, run } = useHarnessOperation(context, recorded, preset.displayName);
  const registration = spaceSwitches.registrationFor(preset.id);
  const spaceSwitch = spaceSwitches.ready && item?.installed ? harnessSpaceSwitch(registration) : null;
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
  const uninstall = item?.installed && state.recipePlatform && preset.management?.uninstall[state.recipePlatform];
  const autoSupported = harnessAutoUpdateSupported(preset);
  const autoState = item?.autoUpdate ?? "unknown";
  const cursorUpdateBlocked = preset.id === "cursor" && item?.installed && !state.cursorUpdateReady;
  const updateAvailable = harnessUpdateAvailable(item?.version, item?.latestVersion);
  const act = (action: HarnessAction) => { setArmed(false); run({ presetId: preset.id, action }); };
  return <tr className={`grid grid-cols-2 gap-2 py-3 sm:table-row sm:py-0${beforeDivider ? "" : " border-b last:border-0"}`}>
    <th scope="row" className="col-span-2 min-w-0 pr-3 font-medium sm:py-3">{preset.displayName}</th>
    <td className="min-w-0 pr-3 [overflow-wrap:anywhere]"><span className="block text-muted-foreground sm:hidden">Installed version</span>{item?.installed ? item.version ?? "Installed"
      : item?.probeStatus === "unsupported" ? <span className="text-muted-foreground">Unsupported</span> : null}</td>
    <td className="min-w-0 pr-3 [overflow-wrap:anywhere]"><span className="block text-muted-foreground sm:hidden">Latest</span>{updateAvailable && item?.latestVersion}</td>
    <td className="col-span-2 min-w-0 pr-3"><span className="block text-muted-foreground sm:hidden">Automatic updates</span>
      {item?.installed && autoSupported
        ? <span className="inline-flex items-center gap-2">
          <Switch checked={autoState === "enabled"} disabled={!state.canManage || busy}
            label={`Automatic updates: ${preset.displayName}`}
            onChange={(on) => act(on ? "auto_update_on" : "auto_update_off")} />
          {autoState === "unknown" && <span className="text-muted-foreground">Unknown</span>}
        </span>
        : null}</td>
    {spaceSwitches.owner && <td className="col-span-2 min-w-0 pr-3"><span className="block text-muted-foreground sm:hidden">Enabled</span>
      {spaceSwitch && <span className="inline-flex items-center gap-2"
        title={spaceSwitch.on ? "Turning it off stops its running work" : "Let it take work"}>
        <Switch checked={spacePending ? spacePending.on : spaceSwitch.on} disabled={Boolean(spaceSwitches.pending)}
          label={`Enabled: ${preset.displayName}`} onChange={(on) => void spaceSwitches.set(preset, on)} />
        {spacePending && <span className="text-muted-foreground">{spacePending.on ? "Turning on…" : "Turning off…"}</span>}
      </span>}</td>}
    <td className="col-span-2 min-w-0"><div className="flex flex-wrap gap-1">
      <Button size="sm" variant="outline" disabled={!state.canManage || busy || !item || cursorUpdateBlocked || (item.installed ? !update : !install)}
        title={item?.installed ? update ? harnessCommandLabel(update) : undefined : install ? harnessCommandLabel(install) : undefined}
        onClick={() => act(item?.installed ? "update" : "install")}>
        {item?.installed ? "Update" : "Install"}</Button>
      {uninstall && <Button size="sm" variant={armed ? "destructive" : "outline"} disabled={!state.canManage || busy || !state.uninstallReady}
        title={harnessCommandLabel(uninstall)} onBlur={() => setArmed(false)}
        onClick={() => armed ? act("uninstall") : setArmed(true)}>
        {armed ? "Confirm uninstall" : "Uninstall"}</Button>}
    </div>{armed && <p className="text-muted-foreground">Settings and sessions are kept. Running instances may stop working.</p>}
      {operation && <OperationStatus operation={operation} status={status} displayName={preset.displayName}
        responding={state.responding} />}{cursorUpdateBlocked && <p className="text-muted-foreground">Update this machine&apos;s daemon before updating Cursor.</p>}
      {uninstall && state.canManage && !state.uninstallReady && <p className="text-muted-foreground">Update this machine&apos;s daemon to uninstall.</p>}</td>
  </tr>;
}
