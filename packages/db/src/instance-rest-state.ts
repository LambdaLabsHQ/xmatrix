import { automationRunIdentity } from "@xmatrix/protocol";

/**
 * Why an offline Instance is offline (docs/instance-sleep.md §1), as stored in
 * `data.instances.rest_state`. `sleeping` and `interrupted` Instances are woken
 * by the next message in their Channel; a `stopped` one only by a reborn.
 */
export type InstanceRestState = "sleeping" | "interrupted" | "stopped";

/**
 * A Run whose Instance a Channel message may resume: its harness session is
 * keyed and it belongs to the conversation rather than
 * to an Automation, a management surface or a deleted/handed-off Instance.
 */
export function resumableChannelRun(metadata: Readonly<Record<string, unknown>>): boolean {
  if (typeof metadata.resumeSessionKey !== "string" || !metadata.resumeSessionKey.trim()) return false;
  if (metadata.instanceDeletion !== undefined || metadata.instanceHandoff !== undefined) return false;
  if (typeof metadata.routedAs === "string" && metadata.routedAs.startsWith("management_")) return false;
  if (metadata.channelDeliveryEnabled === false) return false;
  return automationRunIdentity(metadata).automationId === undefined;
}

/**
 * The rest state a Run's end leaves its Instance in, or `null` when the
 * Instance is simply gone. `previousRunStatus` is the Run's status before this
 * report: a Run that never connected failed at startup, and waking it would
 * repeat that failure; a Run that was already `stopping` ended because someone
 * stopped it.
 */
export function runEndRestState(input: {
  metadata: Readonly<Record<string, unknown>>;
  previousRunStatus: string;
  nextRunStatus: string;
  restReason?: unknown;
}): InstanceRestState | null {
  if (!resumableChannelRun(input.metadata)) return null;
  if (input.previousRunStatus === "stopping" || input.metadata.stopRequest !== undefined ||
      input.nextRunStatus === "stopped") return "stopped";
  if (input.previousRunStatus !== "running" || input.nextRunStatus !== "exited") return null;
  return input.restReason === "sleeping" ? "sleeping" : "interrupted";
}
