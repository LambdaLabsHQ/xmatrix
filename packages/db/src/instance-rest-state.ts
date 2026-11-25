import { automationRunIdentity, runPhaseBeforeReady } from "@xmatrix/protocol";

/**
 * Why an offline Instance is offline (docs/instance-sleep.md §1), as stored in
 * `data.instances.rest_state`. `sleeping` and `interrupted` Instances are woken
 * by the next message in their Channel; terminal startup failures require a reborn.
 */
export type InstanceRestState = "sleeping" | "interrupted" | "stopped" | "wake_failed";

/**
 * A Run whose Instance a Channel message may resume: its harness session is
 * keyed and it belongs to the conversation rather than
 * to an Automation, a management surface or a deleted/handed-off Instance.
 */
export function resumableChannelRun(metadata: Readonly<Record<string, unknown>>): boolean {
  if (typeof metadata.resumeSessionKey !== "string" || !metadata.resumeSessionKey.trim()) return false;
  if (metadata.instanceDeletion !== undefined || metadata.instanceHandoff !== undefined) return false;
  if (typeof metadata.routedAs === "string" && metadata.routedAs.startsWith("management_")) return false;
  return automationRunIdentity(metadata).automationId === undefined;
}

/**
 * The rest state a Run's end leaves its Instance in, or `null` when the
 * Instance is simply gone. `previousRunStatus` is the Run's status before this
 * report: a Run that never connected failed at startup, and waking it would
 * repeat that failure; a Run that was already `stopping` ended because someone
 * stopped it. An Instance's first Run (`#1`) that connected and then ended
 * before its agent was ready (`statusPhase`: its program refused to start,
 * signed out for one) never worked either: left `interrupted`, every later
 * message in its Channel would start it and fail again. A confirmed wrapper
 * startup failure also ends automatic wakes of an established Instance. Other
 * interrupted starts can still recover, including after sign-in.
 */
export function runEndRestState(input: {
  metadata: Readonly<Record<string, unknown>>;
  previousRunStatus: string;
  nextRunStatus: string;
  restReason?: unknown;
  runId?: string;
  statusPhase?: unknown;
  wrapperStartupFailed?: boolean;
}): InstanceRestState | null {
  if (!resumableChannelRun(input.metadata)) return null;
  if (input.previousRunStatus === "stopping" || input.metadata.stopRequest !== undefined ||
      input.nextRunStatus === "stopped") return "stopped";
  if (input.wrapperStartupFailed && input.nextRunStatus === "exited") return "wake_failed";
  if (input.previousRunStatus !== "running" || input.nextRunStatus !== "exited") return null;
  if (input.runId?.endsWith("#1") && typeof input.statusPhase === "string" && runPhaseBeforeReady(input.statusPhase)) return null;
  return input.restReason === "sleeping" ? "sleeping" : "interrupted";
}
