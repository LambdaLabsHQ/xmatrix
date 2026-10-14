import {
  agentTurnFailureNoticeBody,
  isAgentTurnFailureLifecycle,
  boundAgentTurnFailureDetail,
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
  if (background && (!input.noticeId || !/^[a-zA-Z0-9_-]{1,120}$/.test(input.noticeId))) return null;
  const body = background
    ? `xMatrix lost background-task tracking for ${input.agentName.trim() || "agent"}. ${backgroundInterruptionDetail(input)}`.trim()
    : agentTurnFailureNoticeBody({
    agentName: input.agentName,
    detail: input.detail,
  });
  const identity = [
    input.instanceId.trim() || input.runId.trim(),
    ...(background ? [channelId, input.noticeId!] : []),
    body.replace(/\s+/gu, " ").slice(0, TURN_FAILURE_NOTICE_IDENTITY_MAX),
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
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return boundAgentTurnFailureDetail(input.detail);
  return `The provider stream ended with ${count} ${count === 1 ? "task" : "tasks"} still pending. ` +
    "Their outcome is unknown; verify external operations before continuing.";
}
