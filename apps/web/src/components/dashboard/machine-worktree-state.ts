import { MACHINE_WORKTREE_ACTION_CAPABILITY, XMATRIX_WORKTREE_ORIGINS, type MachineWorktreeEntry,
  type SerializedMachineDaemon, type WorktreeOrigin } from "@xmatrix/protocol";

/** The idle floor of automatic clean-up, and of the one-click "Clean up idle". */
export const WORKTREE_IDLE_FLOOR_SECS = 7 * 24 * 60 * 60;

const ORIGIN_LABELS: Record<WorktreeOrigin, string> = {
  "repo-pool": "xMatrix", "run-worktree": "xMatrix", "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor",
  manual: "Other",
};

export function worktreeOriginLabel(origin: WorktreeOrigin): string {
  return ORIGIN_LABELS[origin];
}

/** Created by a harness (or by hand): everything xMatrix did not create and does not clean up itself. */
export function createdByHarness(tree: MachineWorktreeEntry): boolean {
  return !XMATRIX_WORKTREE_ORIGINS.includes(tree.origin);
}

/** A tree the owner may clean up from here; the daemon checks again before it deletes anything. */
export function worktreeReclaimable(tree: MachineWorktreeEntry): boolean {
  return createdByHarness(tree) && !tree.inUse && !tree.locked && !tree.missing && tree.idleSecs !== undefined;
}

export function idleWorktrees(trees: readonly MachineWorktreeEntry[]): MachineWorktreeEntry[] {
  return trees.filter((tree) => worktreeReclaimable(tree) && (tree.idleSecs ?? 0) >= WORKTREE_IDLE_FLOOR_SECS);
}

/** Largest first, since space is what the list is for; unsized trees after, most idle first. */
export function sortWorktrees(trees: readonly MachineWorktreeEntry[]): MachineWorktreeEntry[] {
  return [...trees].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) ||
    (b.idleSecs ?? -1) - (a.idleSecs ?? -1) || a.path.localeCompare(b.path));
}

export function totalBytes(trees: readonly MachineWorktreeEntry[]): number {
  return trees.reduce((sum, tree) => sum + (tree.sizeBytes ?? 0), 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  const gb = bytes / 1024 ** 3;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function formatIdle(secs: number | undefined): string | null {
  if (secs === undefined) return null;
  if (secs >= 24 * 60 * 60) return `${Math.floor(secs / (24 * 60 * 60))}d`;
  if (secs >= 60 * 60) return `${Math.floor(secs / (60 * 60))}h`;
  return `${Math.max(1, Math.floor(secs / 60))}m`;
}

/** The folder name a person recognizes a tree by. */
export function worktreeName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export function machineWorktreeState(daemon: SerializedMachineDaemon | undefined, userId?: string) {
  const capabilities = daemon?.metadata.capabilities;
  const owner = Boolean(daemon && daemon.userId === userId && daemon.machineId);
  const capable = Array.isArray(capabilities) && capabilities.includes(MACHINE_WORKTREE_ACTION_CAPABILITY);
  return { owner, capable, canManage: owner && capable && daemon?.status === "online" };
}
