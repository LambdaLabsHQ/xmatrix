import { plainRecord as record } from "./plain-record.js";
import { hasControlCharacter } from "./field-validation.js";

/**
 * The owner manages the git worktrees on one of their Machines. The daemon is
 * the only source: it lists what git has registered at that moment and
 * reclaims only trees it lists itself, so a path named here is a request,
 * never authority to delete it. Hub keeps no inventory beyond the action's
 * own result.
 */
export const WORKTREE_ACTIONS = ["list", "reclaim", "auto_reclaim_on", "auto_reclaim_off"] as const;
export type WorktreeAction = typeof WORKTREE_ACTIONS[number];
export const MACHINE_WORKTREE_ACTION_CAPABILITY = "machine_worktree_action_v1";
/** Who created a tree. `repo-pool` and `run-worktree` are xMatrix's own, which it reclaims itself. */
export const WORKTREE_ORIGINS = ["repo-pool", "run-worktree", "claude-code", "codex", "cursor", "manual"] as const;
export type WorktreeOrigin = typeof WORKTREE_ORIGINS[number];
export const XMATRIX_WORKTREE_ORIGINS: readonly WorktreeOrigin[] = ["repo-pool", "run-worktree"];
/** Unclaimed this long, a request expires instead of running late. */
export const WORKTREE_ACTION_CLAIM_TTL_MS = 10 * 60_000;
/** Longest the daemon spends on one action; sizing and snapshots of many trees take a while. */
export const WORKTREE_ACTION_TIMEOUT_MS = 10 * 60_000;
export const WORKTREE_ACTION_SETTLE_MS = WORKTREE_ACTION_CLAIM_TTL_MS + WORKTREE_ACTION_TIMEOUT_MS + 2 * 60_000;
export const WORKTREE_RECLAIM_PATHS_MAX = 500;
export const WORKTREE_INVENTORY_TREES_MAX = 1_000;
const PATH_MAX = 4_096;
const TEXT_MAX = 256;
const RESULT_JSON_MAX = 768 * 1024;
const REQUEST_ID = /^worktree:[0-9a-f-]{36}$/u;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u;

export interface WorktreeActionRequest {
  requestId: string;
  action: WorktreeAction;
  /** Only on `reclaim`: the trees the owner chose from a listing. */
  paths?: string[];
}

export interface MachineWorktreeEntry {
  path: string;
  origin: WorktreeOrigin;
  branch?: string;
  /** Locked by someone other than xMatrix; never reclaimed. */
  locked: boolean;
  /** Registered with git but its directory is gone. */
  missing: boolean;
  idleSecs?: number;
  /** Absent when sizing ran out of time. */
  sizeBytes?: number;
  /** Uncommitted changes or commits no remote has; snapshotted before reclaim. */
  unlanded?: boolean;
  /** A process on the machine works inside it; never reclaimed. */
  inUse: boolean;
}

export interface WorktreeInventory {
  capturedAt: string;
  /** The owner's switch for reclaiming trees xMatrix did not create. */
  foreignAutoReclaim: boolean;
  trees: MachineWorktreeEntry[];
  /** More trees exist than one listing carries. */
  truncated?: boolean;
}

export interface WorktreeActionResult {
  action: WorktreeAction;
  status: "succeeded" | "failed";
  /** On `list`. */
  inventory?: WorktreeInventory;
  /** On `reclaim`. */
  reclaimed?: Array<{ path: string; snapshotted: boolean; sizeBytes?: number }>;
  kept?: Array<{ path: string; reason: string }>;
  /** On the switches: the setting now in force. */
  foreignAutoReclaim?: boolean;
  error?: string;
}

export interface WorktreeActionStatus {
  controlId: string;
  action: WorktreeAction;
  status: "queued" | "running" | "succeeded" | "failed" | "expired";
  result?: WorktreeActionResult;
  error?: string;
  requestedAt?: string;
  completedAt?: string;
}

function isWorktreeAction(value: unknown): value is WorktreeAction {
  return typeof value === "string" && (WORKTREE_ACTIONS as readonly string[]).includes(value);
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= PATH_MAX && !hasControlCharacter(value);
}

function validText(value: unknown, max = TEXT_MAX): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !hasControlCharacter(value);
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseWorktreeActionRequest(value: unknown): WorktreeActionRequest {
  const input = record(value);
  if (!input || typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId) ||
      !isWorktreeAction(input.action)) throw new Error("Invalid worktree action request");
  if (input.action !== "reclaim") {
    if (input.paths !== undefined) throw new Error("Invalid worktree action request");
    return { requestId: input.requestId, action: input.action };
  }
  const paths = input.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > WORKTREE_RECLAIM_PATHS_MAX ||
      !paths.every(validPath) || new Set(paths).size !== paths.length) {
    throw new Error("Invalid worktree action request");
  }
  return { requestId: input.requestId, action: input.action, paths: [...paths] as string[] };
}

function parseEntry(value: unknown): MachineWorktreeEntry {
  const input = record(value);
  if (!input || !validPath(input.path) || !(WORKTREE_ORIGINS as readonly unknown[]).includes(input.origin) ||
      typeof input.locked !== "boolean" || typeof input.missing !== "boolean" || typeof input.inUse !== "boolean" ||
      (input.branch !== undefined && !validText(input.branch)) ||
      (input.idleSecs !== undefined && !validCount(input.idleSecs)) ||
      (input.sizeBytes !== undefined && !validCount(input.sizeBytes)) ||
      (input.unlanded !== undefined && typeof input.unlanded !== "boolean")) {
    throw new Error("Worktree inventory entry is invalid");
  }
  return { path: input.path, origin: input.origin as WorktreeOrigin, locked: input.locked, missing: input.missing,
    inUse: input.inUse,
    ...(input.branch === undefined ? {} : { branch: input.branch as string }),
    ...(input.idleSecs === undefined ? {} : { idleSecs: input.idleSecs as number }),
    ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes as number }),
    ...(input.unlanded === undefined ? {} : { unlanded: input.unlanded as boolean }) };
}

function parseInventory(value: unknown): WorktreeInventory {
  const input = record(value);
  if (!input || typeof input.capturedAt !== "string" || !TIMESTAMP.test(input.capturedAt) ||
      !Number.isFinite(Date.parse(input.capturedAt)) || typeof input.foreignAutoReclaim !== "boolean" ||
      !Array.isArray(input.trees) || input.trees.length > WORKTREE_INVENTORY_TREES_MAX ||
      (input.truncated !== undefined && typeof input.truncated !== "boolean")) {
    throw new Error("Worktree inventory is invalid");
  }
  return { capturedAt: input.capturedAt, foreignAutoReclaim: input.foreignAutoReclaim,
    trees: input.trees.map(parseEntry), ...(input.truncated ? { truncated: true } : {}) };
}

/** Fail closed: a result answers exactly the issued action, and reclaim reports only paths it was asked for. */
export function parseWorktreeActionResult(value: unknown, issued: WorktreeActionRequest): WorktreeActionResult {
  const input = record(value);
  if (!input || input.action !== issued.action || (input.status !== "succeeded" && input.status !== "failed") ||
      (input.error !== undefined && !validText(input.error, 1_024))) {
    throw new Error("Worktree action result differs from the issued request");
  }
  const asked = new Set(issued.paths ?? []);
  const result: WorktreeActionResult = { action: issued.action, status: input.status,
    ...(input.error === undefined ? {} : { error: input.error as string }) };
  if (input.inventory !== undefined) {
    if (issued.action !== "list") throw new Error("Worktree action result inventory is unexpected");
    result.inventory = parseInventory(input.inventory);
  }
  if (input.reclaimed !== undefined || input.kept !== undefined) {
    if (issued.action !== "reclaim") throw new Error("Worktree reclaim outcome is unexpected");
    const reclaimed = input.reclaimed ?? [];
    const kept = input.kept ?? [];
    if (!Array.isArray(reclaimed) || !Array.isArray(kept)) throw new Error("Worktree reclaim outcome is invalid");
    result.reclaimed = reclaimed.map((value) => {
      const entry = record(value);
      if (!entry || !validPath(entry.path) || !asked.has(entry.path) || typeof entry.snapshotted !== "boolean" ||
          (entry.sizeBytes !== undefined && !validCount(entry.sizeBytes))) throw new Error("Worktree reclaim outcome is invalid");
      return { path: entry.path, snapshotted: entry.snapshotted,
        ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes as number }) };
    });
    result.kept = kept.map((value) => {
      const entry = record(value);
      if (!entry || !validPath(entry.path) || !asked.has(entry.path) || !validText(entry.reason, 1_024)) {
        throw new Error("Worktree reclaim outcome is invalid");
      }
      return { path: entry.path, reason: entry.reason };
    });
  }
  if (input.foreignAutoReclaim !== undefined) {
    if (typeof input.foreignAutoReclaim !== "boolean") throw new Error("Worktree setting is invalid");
    result.foreignAutoReclaim = input.foreignAutoReclaim;
  }
  if (JSON.stringify(result).length > RESULT_JSON_MAX) throw new Error("Worktree action result is too large");
  return result;
}
