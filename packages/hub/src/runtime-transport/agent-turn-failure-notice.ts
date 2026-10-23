import {
  AGENT_SIGNED_OUT_LIFECYCLE_REASON,
  HARNESS_SIGNED_OUT_NOTICE_KIND,
  type HarnessSignedOut,
  agentTurnFailureNoticeBody,
  isAgentTurnFailureLifecycle,
  boundAgentTurnFailureDetail,
  safeAgentFailureDetail,
  agentFailureEvidence,
} from "@xmatrix/protocol";

import { runtimeCommandId } from "./runtime-messages";

const TURN_FAILURE_NOTICE_IDENTITY_MAX = 120;

export function agentTurnFailureAppendCommand(input: {
  runId: string;
  instanceId: string;
  executionKey: string;
  agentId: string;
  agentName: string;
  ownerUserId: string;
  channelId: string;
  detail?: string | null;
  /** The host's count of tasks still pending when its provider stream ended. */
  pendingTasks?: number | null;
  reason?: string | null;
  /** For a turn its program refused as signed out: what to sign in, drawn as the sign-in. */
  signedOut?: HarnessSignedOut;
  noticeId?: string | null;
  senderSnapshot: Record<string, unknown>;
}): {
  commandId: string;
  messageId: string;
  body: string;
  payload: Record<string, unknown>;
} | null {
  const channelId = input.channelId.trim();
  if (!channelId) return null;
  const background = input.reason === "background_tasks_interrupted";
  // A notice that names its failure is keyed by it; one without falls back to
  // the Instance and its opening text, which a replay repeats exactly.
  if (input.noticeId ? !/^[a-zA-Z0-9_-]{1,120}$/.test(input.noticeId) : background) return null;
  const body = background
    ? `xMatrix lost background-task tracking for ${input.agentName.trim() || "agent"}. ${backgroundInterruptionDetail(input)}`.trim()
    : [agentTurnFailureNoticeBody({
      agentName: input.agentName,
      detail: input.detail,
    }), ...(input.noticeId ? ["Failure reference: " + input.noticeId] : [])].join("\n");
  const identity = [
    input.instanceId.trim() || input.runId.trim(),
    // Legacy hosts keyed only the original cause line. Added evidence must
    // not create another notice when that old failure reconnects after rollout.
    ...(input.noticeId ? [channelId, input.noticeId] : [body.split("\n")[0]!.replace(/\s+/gu, " ").slice(0, TURN_FAILURE_NOTICE_IDENTITY_MAX)]),
  ].join(":");
  const messageId = runtimeCommandId("turn-failure", identity);
  return {
    commandId: runtimeCommandId("agent-turn-failure", messageId),
    messageId,
    body,
    payload: {
      commandId: runtimeCommandId("agent-append", messageId),
      messageId,
      channelId,
      body,
      messageKind: "xmatrix.system.runtime-failure",
      principal: { kind: "agent", id: input.agentId },
      agentRunProof: {
        runId: input.runId,
        executionKey: input.executionKey,
        instanceId: input.instanceId,
      },
      senderSnapshot: input.senderSnapshot,
      residual: {
        appMetadata: {
          xmatrixProvenance: "system_fact",
          xmatrixSystemNotice: true,
          ...(background ? { xmatrixBackgroundTaskInterruption: true } : { xmatrixTurnFailure: true }),
          ...(!background ? { xmatrixFailureEvidence: { version: 1, ...agentFailureEvidence(input.detail) } } : {}),
          ...(input.signedOut && input.reason === AGENT_SIGNED_OUT_LIFECYCLE_REASON
            ? { kind: HARNESS_SIGNED_OUT_NOTICE_KIND, signedOut: input.signedOut } : {}),
        },
      },
    },
  };
}

export function shouldPersistAgentTurnFailureNotice(message: Parameters<typeof isAgentTurnFailureLifecycle>[0]): boolean {
  return isAgentTurnFailureLifecycle(message) || (message.layer === "application"
    && message.status === "blocked" && message.reason === "background_tasks_interrupted");
}

/** Hub words the interruption from the host's count; an older host sent the sentence. */
function backgroundInterruptionDetail(input: { pendingTasks?: number | null; detail?: string | null }): string {
  const count = input.pendingTasks;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return boundAgentTurnFailureDetail(safeAgentFailureDetail(input.detail));
  return `The provider stream ended with ${count} ${count === 1 ? "task" : "tasks"} still pending. ` +
    "Their outcome is unknown; verify external operations before continuing.";
}
