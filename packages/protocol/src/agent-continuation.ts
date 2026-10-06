import type { AgentLaunchActivity } from "./agent-launch.js";

/** A server-interpreted mention that created a successor Run. Not execution authority. */
export interface AgentContinuationSource {
  schemaVersion: 1;
  kind: "reborn" | "handoff";
  sourceMessageId: string;
  sourceMessageVersion: number;
  sourceMention: string;
  sourceInstanceId: string;
  sourceRunId: string;
  sourceName: string;
  sourceOrdinal: number;
  targetInstanceId: string;
}

/** The durable reborn intent's own progress: it exists from the moment the
 *  reborn is accepted, before any successor Run does. */
export interface AgentRebornProgress {
  /** waiting: the predecessor is being stopped; prepared: the successor Run
   *  exists and its resume is being started; spawned: the machine accepted the
   *  resume; failed: recovery ended with `errorCode`. */
  state: "waiting" | "prepared" | "spawned" | "failed";
  /** Whether the predecessor was still live and had to be stopped first. */
  stopRequired: boolean;
  errorCode?: string;
  updatedAt: string;
}

export interface SerializedAgentContinuation extends AgentContinuationSource {
  /** The successor Run id, reserved when the continuation is accepted. */
  runId: string;
  channelId: string;
  targetName: string;
  targetAvatarUrl?: string;
  /** When the continuation was accepted. */
  createdAt: string;
  /** When the successor Run was created; absent until it exists. */
  runCreatedAt?: string;
  predecessorExitedAt?: string;
  handoffFencedAt?: string;
  reborn?: AgentRebornProgress;
  /** The successor Run's startup evidence; absent until it exists. */
  activity?: AgentLaunchActivity;
}

const REBORN_FAILURE_REASONS: Record<string, string> = {
  reborn_source_changed: "The original Instance binding changed (Run, Channel number, machine, workspace or session).",
  reborn_source_fenced: "The original Instance was deleted, transferred or cancelled.",
  reborn_expired: "Recovery expired before the original stop and resume could complete.",
  forbidden: "Current permissions do not allow this recovery.",
  not_found: "The original recovery target is no longer available.",
  channel_not_found: "The Channel is unavailable or access was removed.",
  channel_archived: "The Channel is archived.",
  invalid_runtime_request: "The recovery request does not match its required execution binding.",
  reborn_stop_rejected: "The daemon rejected the request to stop the original execution.",
  reborn_stop_status_rejected: "Access to the original stop result was refused.",
  reborn_stop_failed: "Stopping the original execution failed.",
  reborn_spawn_rejected: "xMatrix or the daemon refused the request to resume the original session.",
  reborn_spawn_status_rejected: "Access to the resume result was refused.",
  reborn_spawn_failed: "Resuming the original session failed.",
  reborn_internal_error: "xMatrix could not record the successor, and retrying would fail the same way.",
};

/** A public reborn failure code and the sentence that explains it. Unknown
 *  codes collapse to `reborn_failed` so no internal code leaks. */
export function rebornFailureReason(code: string | undefined): { code: string; reason: string } {
  return code && Object.hasOwn(REBORN_FAILURE_REASONS, code)
    ? { code, reason: REBORN_FAILURE_REASONS[code]! }
    : { code: "reborn_failed", reason: "Recovery could not complete." };
}
