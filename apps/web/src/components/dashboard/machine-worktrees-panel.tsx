"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, FolderGit2, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { WORKTREE_ACTION_SETTLE_MS, type MachineWorktreeEntry, type SerializedMachineDaemon, type WorktreeAction,
  type WorktreeActionStatus, type WorktreeInventory } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { statusChipClass, statusInkClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { UserFacingProblem, userErrorMessage } from "@/lib/user-facing-error";
import { cn } from "@/lib/utils";
import { ToolDetailSection } from "./tool-split";
import { queueWorktreeAction, readLatestWorktreeListing, readWorktreeAction } from "./machine-worktree-api";
import { createdByHarness, formatBytes, formatIdle, idleWorktrees, machineWorktreeState, sortWorktrees, totalBytes,
  worktreeName, worktreeOriginLabel, worktreeReclaimable } from "./machine-worktree-state";
import { relativeTime } from "./workspace-shell-recovered";

/** Rows shown before "Show all": the largest trees, which is where the space is. */
const FIRST_ROWS = 8;
/** A listing older than this is taken again when the section opens. */
const STALE_LISTING_MS = 10 * 60_000;
const SETTLED = (status?: WorktreeActionStatus["status"]) => Boolean(status && !["queued", "running"].includes(status));

/** One worktree action and its status, followed until it settles. */
function useWorktreeOperation(token: string | null | undefined, userId: string, machineId: string | undefined,
  onNotice: (notice: string | null) => void) {
  const [operation, setOperation] = useState<{ controlId: string; action: WorktreeAction; paths?: string[];
    startedAt: number } | null>(null);
  const status = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId }, "worktree-actions", [operation?.controlId ?? null]),
    queryFn: ({ signal }) => readWorktreeAction(token!, operation!.controlId, signal),
    enabled: Boolean(token && operation), retry: false, staleTime: 2_000,
    refetchInterval: (query) => operation && Date.now() - operation.startedAt < WORKTREE_ACTION_SETTLE_MS &&
      !SETTLED(query.state.data?.status) ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
  const start = useMutation({
    mutationFn: async (input: { action: WorktreeAction; paths?: string[] }) => {
      if (!token || !machineId) throw new UserFacingProblem("This machine cannot be managed right now.");
      return queueWorktreeAction(token, machineId, input.action, input.paths);
    },
    onSuccess: (result, input) => {
      setOperation({ controlId: result.controlId, action: input.action, paths: input.paths, startedAt: Date.now() });
      onNotice(null);
    },
    onError: (error) => onNotice(userErrorMessage(error, "Couldn't send that to the machine")),
  });
  const pending = start.isPending || Boolean(operation && !SETTLED(status.data?.status) &&
    Date.now() - operation.startedAt < WORKTREE_ACTION_SETTLE_MS);
  return { operation, status: status.data, pending, run: start.mutate };
}

/**
 * Every git worktree on the Machine, from its daemon: the ones xMatrix created
 * and cleans up itself, and the ones harnesses created, which are only listed
 * until the owner cleans them up here or turns automatic clean-up on.
 */
export function MachineWorktreesPanel({ daemon, token }: { daemon?: SerializedMachineDaemon; token?: string | null }) {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const queryClient = useQueryClient();
  const state = machineWorktreeState(daemon, user?.id);
  const machineId = daemon?.machineId;
  const [notice, setNotice] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const latestKey = useMemo(() => xmatrixQueryKeys.domain({ userId }, "worktree-listing", [machineId ?? null]),
    [userId, machineId]);
  const latest = useQuery({ queryKey: latestKey,
    queryFn: ({ signal }) => readLatestWorktreeListing(token!, machineId!, signal),
    enabled: Boolean(token && machineId && state.owner && state.capable), staleTime: 60_000 });
  const listing = useWorktreeOperation(token, userId, machineId, setNotice);
  const change = useWorktreeOperation(token, userId, machineId, setNotice);

  // The listing this page asked for wins over the one Hub kept from before.
  const fresh = listing.status?.status === "succeeded" ? listing.status.result?.inventory : undefined;
  const [inventory, setInventory] = useState<WorktreeInventory | undefined>();
  useEffect(() => {
    const kept = latest.data?.result?.inventory;
    if (fresh) setInventory(fresh);
    else if (kept) setInventory((current) => current && current.capturedAt >= kept.capturedAt ? current : kept);
  }, [fresh, latest.data]);

  // Open on an old or missing listing: ask the machine again, once.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !state.canManage || latest.isLoading) return;
    const captured = latest.data?.result?.inventory?.capturedAt;
    if (captured && Date.now() - Date.parse(captured) < STALE_LISTING_MS) return;
    asked.current = true;
    listing.run({ action: "list" });
  }, [state.canManage, latest.isLoading, latest.data, listing]);

  // A finished clean-up or switch folds into the listing shown, without sizing every tree again.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const done = change.status;
    if (!done || !SETTLED(done.status) || !change.operation || applied.current === change.operation.controlId) return;
    applied.current = change.operation.controlId;
    const result = done.result;
    if (done.status !== "succeeded" || !result) {
      setNotice(done.error ?? "The machine could not do that");
      return;
    }
    if (result.foreignAutoReclaim !== undefined) {
      setInventory((current) => current && { ...current, foreignAutoReclaim: result.foreignAutoReclaim! });
    }
    if (result.reclaimed || result.kept) {
      const gone = new Set((result.reclaimed ?? []).map((entry) => entry.path));
      setNotice(reclaimNotice(gone.size, totalBytes((inventory?.trees ?? []).filter((tree) => gone.has(tree.path))),
        result.kept ?? []));
      setInventory((current) => current && { ...current, trees: current.trees.filter((tree) => !gone.has(tree.path)) });
      void queryClient.invalidateQueries({ queryKey: latestKey });
    }
  }, [change.status, change.operation, queryClient, latestKey, inventory]);

  if (!daemon || !state.owner) return null;
  const trees = sortWorktrees(inventory?.trees ?? []);
  const harnessTrees = trees.filter(createdByHarness);
  const idle = idleWorktrees(trees);
  const shown = showAll ? trees : trees.slice(0, FIRST_ROWS);
  const autoOn = inventory?.foreignAutoReclaim ?? false;
  const switchPending = change.pending && change.operation?.action.startsWith("auto_reclaim");
  const reclaiming = change.pending && change.operation?.action === "reclaim";
  const busy = !state.canManage || change.pending;
  const reclaim = (paths: string[]) => { setArmed(null); change.run({ action: "reclaim", paths }); };
  const title = inventory ? `Worktrees · ${trees.length} · ${formatBytes(totalBytes(trees))}` : "Worktrees";

  return <ToolDetailSection title={title} action={<>
    {inventory && <span className="text-xs text-muted-foreground">Checked {relativeTime(inventory.capturedAt)}</span>}
    <Button size="icon-xs" variant="ghost" className="text-muted-foreground" title="Check again" aria-label="Check worktrees again"
      disabled={!state.canManage || listing.pending} onClick={() => listing.run({ action: "list" })}>
      <RefreshCw className={cn(listing.pending && "animate-spin")} />
    </Button>
  </>}>
    <div className="space-y-2" data-testid="machine-worktrees-panel">
      {!state.canManage && <p className={statusInkClass("secondary", "text-xs")}>{daemon.status !== "online"
        ? "Connect this machine to manage its worktrees." : "Update this machine's daemon to manage its worktrees."}</p>}
      {inventory && <div className="flex min-w-0 items-start gap-2 text-sm">
        <Switch checked={switchPending ? change.operation?.action === "auto_reclaim_on" : autoOn} disabled={busy}
          label="Clean up worktrees created by harnesses"
          onChange={(on) => change.run({ action: on ? "auto_reclaim_on" : "auto_reclaim_off" })} />
        <span className="min-w-0 text-muted-foreground">{autoOn
          ? "Worktrees created by harnesses are cleaned up after 7 idle days, 1 day when the disk is low"
          : "Only xMatrix's own worktrees are cleaned up; the ones harnesses created are listed and left alone"}</span>
      </div>}
      {notice && <p role="status" aria-live="polite" className="text-sm">{notice}</p>}
      {listing.status && SETTLED(listing.status.status) && listing.status.status !== "succeeded" &&
        <p role="alert" className="text-sm text-destructive">{listing.status.error ?? "The machine could not list its worktrees"}</p>}
      {!inventory ? <p className="text-sm text-muted-foreground">{listing.pending
        ? "Asking the machine for its worktrees and their sizes…" : "No listing yet."}</p> : <>
        <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {harnessTrees.length} created by harnesses · {formatBytes(totalBytes(harnessTrees))} · {idle.length} idle 7+ days
          </span>
          {idle.length > 0 && <Button size="xs" variant={armed === "*" ? "destructive" : "outline"} disabled={busy}
            onBlur={() => setArmed(null)}
            onClick={() => armed === "*" ? reclaim(idle.map((tree) => tree.path)) : setArmed("*")}>
            {reclaiming && <Loader2 className="animate-spin" />}
            {armed === "*" ? `Confirm: clean up ${idle.length} · ${formatBytes(totalBytes(idle))}` : `Clean up ${idle.length} idle`}
          </Button>}
        </div>
        {armed === "*" && <p className="text-xs text-muted-foreground">Worktrees in use or locked are kept. Un-landed work is
          committed to <span className="font-mono">refs/xmatrix/snapshot/foreign/…</span> first.</p>}
        {inventory.truncated && <p className={statusInkClass("attention", "text-xs")}>Showing the first {trees.length} worktrees.</p>}
        {trees.length === 0 ? <p className="text-sm text-muted-foreground">No worktrees on this machine.</p> :
          <ul className="app-tool-lines">
            {shown.map((tree) => <WorktreeLine key={tree.path} tree={tree} armed={armed === tree.path} busy={busy}
              onArm={(on) => setArmed(on ? tree.path : null)} onReclaim={() => reclaim([tree.path])} />)}
            {trees.length > FIRST_ROWS && <li className="py-2">
              <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show fewer" : `Show all ${trees.length}`}
                <ChevronDown className={cn(showAll && "rotate-180")} />
              </Button>
            </li>}
          </ul>}
      </>}
    </div>
  </ToolDetailSection>;
}

function reclaimNotice(count: number, freed: number, kept: { path: string; reason: string }[]): string {
  const done = count === 0 ? "Nothing was cleaned up."
    : `Cleaned up ${count} worktree${count === 1 ? "" : "s"}${freed ? `, freed ${formatBytes(freed)}` : ""}.`;
  if (kept.length === 0) return done;
  const reasons = [...new Set(kept.map((entry) => entry.reason))].slice(0, 2).join("; ");
  return `${done} Kept ${kept.length}: ${reasons}.`;
}

function WorktreeLine({ tree, armed, busy, onArm, onReclaim }: {
  tree: MachineWorktreeEntry; armed: boolean; busy: boolean; onArm: (on: boolean) => void; onReclaim: () => void;
}) {
  const idle = formatIdle(tree.idleSecs);
  const reclaimable = worktreeReclaimable(tree);
  return <li className="group/line flex min-w-0 items-center gap-3 py-2.5" data-testid="machine-worktree">
    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"><FolderGit2 className="size-4" /></span>
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="truncate font-semibold">{worktreeName(tree.path)}</span>
        {tree.unlanded && <span className={statusChipClass("attention", "shrink-0")}>Un-landed work</span>}
        {tree.inUse && <span className={statusChipClass("secondary", "shrink-0")}>In use</span>}
        {tree.locked && <span className={statusChipClass("secondary", "shrink-0")}>Locked</span>}
        {tree.missing && <span className={statusChipClass("secondary", "shrink-0")}>Missing</span>}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground" title={tree.path}>
        {worktreeOriginLabel(tree.origin)} · <span className="font-mono">{tree.path}</span>{tree.branch ? ` · ${tree.branch}` : ""}
      </div>
      {armed && <p className="mt-1 text-xs text-muted-foreground">Un-landed work is committed to <span
        className="font-mono">refs/xmatrix/snapshot/foreign/…</span> first, then the folder is deleted.</p>}
    </div>
    <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
      {tree.sizeBytes !== undefined && <span className="font-semibold text-foreground">{formatBytes(tree.sizeBytes)}</span>}
      {tree.sizeBytes !== undefined && idle ? " · " : null}{idle}
    </span>
    <div className={cn("flex w-8 shrink-0 items-center justify-end", armed && "w-auto",
      !armed && "opacity-100 md:opacity-0 md:group-hover/line:opacity-100 md:focus-within:opacity-100")}>
      {reclaimable && (armed
        ? <Button size="xs" variant="destructive" disabled={busy} onBlur={() => onArm(false)} onClick={onReclaim}>Confirm clean-up</Button>
        : <Button size="icon-sm" variant="ghost" className="text-muted-foreground" title="Clean up" aria-label={`Clean up ${worktreeName(tree.path)}`}
          disabled={busy} onClick={() => onArm(true)}><Trash2 /></Button>)}
    </div>
  </li>;
}
