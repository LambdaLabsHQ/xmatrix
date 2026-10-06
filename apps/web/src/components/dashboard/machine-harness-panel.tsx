"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HarnessAction, SerializedMachineDaemon } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { fetchMachineDaemons } from "./workspace-admin-views";
import { queueHarnessAction, readHarnessAction, refreshHarnessInventory } from "./machine-harness-api";
import { harnessAutoUpdateSupported, harnessCommandLabel, harnessUpdateAvailable, machineHarnessState } from "./machine-harness-state";

const ACTION_LABELS: Record<HarnessAction, string> = {
  install: "Install", update: "Update", uninstall: "Uninstall", auto_update_on: "Enable automatic updates",
  auto_update_off: "Disable automatic updates", refresh: "Refresh inventory", release: "Check for a new release",
};

type HarnessRowState = ReturnType<typeof machineHarnessState>["rows"][number];
type Operation = { controlId: string; label: string; startedAt: number };

/** One harness action and its status, followed until it settles. Each row
 * (and Refresh) holds its own, because the daemon runs actions on different
 * harnesses side by side and refuses only a second one on the same harness:
 * updating Claude Code must not stop the other rows. */
function useHarnessOperation({ token, userId, daemonKey, current, canManage, onNotice }: {
  token?: string | null; userId: string; daemonKey: readonly unknown[];
  current?: SerializedMachineDaemon; canManage: boolean; onNotice: (notice: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [operation, setOperation] = useState<Operation | null>(null);
  const status = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId }, "harness-actions", [operation?.controlId ?? null]),
    queryFn: ({ signal }) => readHarnessAction(token!, operation!.controlId, signal),
    enabled: Boolean(token && operation), retry: false,
    refetchInterval: (query) => operation && Date.now() - operation.startedAt < 20 * 60_000 &&
      (!query.state.data || ["queued", "running"].includes(query.state.data.status)) ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const pending = Boolean(operation && (!status.data || ["queued", "running"].includes(status.data.status)));
  useEffect(() => {
    if (status.data && !["queued", "running"].includes(status.data.status)) {
      void queryClient.invalidateQueries({ queryKey: daemonKey });
    }
  }, [status.data, operation?.controlId, queryClient, daemonKey]);
  const action = useMutation({
    mutationFn: async (input: { presetId: string; action: HarnessAction }) => {
      if (!token || !current?.machineId || !canManage) throw new Error("This machine cannot be managed right now.");
      return input.action === "refresh"
        ? refreshHarnessInventory(token, current.machineId, current.hostId)
        : queueHarnessAction(token, current.machineId, current.hostId, input.presetId, input.action);
    },
    onSuccess: (result, input) => {
      setOperation({ controlId: result.controlId, label: `${ACTION_LABELS[input.action]}${input.action === "refresh" ? "" : ` · ${input.presetId}`}`, startedAt: Date.now() });
      onNotice(null);
    },
    onError: (error) => onNotice(error instanceof Error ? error.message : "The operation could not be requested."),
  });
  return { operation, status, busy: pending || action.isPending, run: action.mutate };
}

function OperationStatus({ operation, status }: {
  operation: Operation; status: ReturnType<typeof useHarnessOperation>["status"];
}) {
  return <div aria-live="polite" className="mt-1 space-y-1">
    <p>{operation.label}: {status.data?.status ?? "Waiting for status"}</p>
    {status.data?.error && <p className="text-destructive">{status.data.error}</p>}
    {status.isError && <><p className="text-destructive">Status could not be checked. The operation may still be running.</p>
      <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>Check status</Button></>}
    {status.data?.result?.outputTail && <details><summary>Command output</summary>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{status.data.result.outputTail.slice(-4096)}</pre>
    </details>}
  </div>;
}

export function MachineHarnessPanel({ daemon, token }: {
  daemon?: SerializedMachineDaemon; token?: string | null;
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
  const refresh = useHarnessOperation(context);

  return <div className="space-y-3" data-testid="machine-harness-panel">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">{state.inventory
        ? `Last checked ${new Date(state.inventory.capturedAt).toLocaleString()}` : "No harness inventory reported yet."}</p>
      <Button size="sm" variant="outline" disabled={!state.canManage || refresh.busy}
        onClick={() => refresh.run({ presetId: "custom", action: "refresh" })}>Refresh</Button>
    </div>
    {!state.canManage && <p className="text-xs text-muted-foreground">{current?.status !== "online"
      ? "Connect this machine to refresh or manage harnesses."
      : current?.userId !== user?.id ? "Only the machine owner can manage harnesses."
        : "Update this machine's daemon to enable harness management."}</p>}
    {notice && <p role="alert" className="text-sm text-destructive">{notice}</p>}
    {daemons.isError && <p role="alert" className="text-xs text-destructive">Inventory could not be refreshed. Showing the last reported observation.</p>}
    {refresh.operation && <div className="text-sm"><OperationStatus operation={refresh.operation} status={refresh.status} /></div>}
    <div><table className="block w-full text-left text-xs sm:table">
      <thead className="hidden sm:table-header-group"><tr className="border-b text-muted-foreground"><th className="py-2 pr-3">Harness</th><th className="pr-3">Installed version</th>
        <th className="pr-3">Latest</th><th className="pr-3">Automatic updates</th><th>Actions</th></tr></thead>
      <tbody className="block sm:table-row-group">{state.rows.map((row, index) => {
        const beforeDivider = Boolean(row.item?.installed) && index + 1 < state.rows.length && !state.rows[index + 1]?.item?.installed;
        return <Fragment key={row.preset.id}>
          <HarnessRow row={row} state={state} context={context} beforeDivider={beforeDivider} />
          {beforeDivider && <HarnessInstallDivider />}
        </Fragment>;
      })}</tbody>
    </table></div>
  </div>;
}

function HarnessInstallDivider() {
  return <tr data-testid="harness-install-divider" role="separator" aria-hidden="true" className="block sm:table-row">
    <td colSpan={5} className="block px-0 py-2 sm:table-cell"><div className="h-px bg-border" /></td>
  </tr>;
}

function HarnessRow({ row: { preset, item }, state, context, beforeDivider = false }: {
  row: HarnessRowState; state: ReturnType<typeof machineHarnessState>;
  context: Parameters<typeof useHarnessOperation>[0]; beforeDivider?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const { operation, status, busy, run } = useHarnessOperation(context);
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
      {operation && <OperationStatus operation={operation} status={status} />}{cursorUpdateBlocked && <p className="text-muted-foreground">Update this machine&apos;s daemon before updating Cursor.</p>}
      {uninstall && state.canManage && !state.uninstallReady && <p className="text-muted-foreground">Update this machine&apos;s daemon to uninstall.</p>}</td>
  </tr>;
}
