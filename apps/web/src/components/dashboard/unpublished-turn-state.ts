import type { SerializedAgentMessageExecution } from "@xmatrix/protocol";

/** A completed model turn is not proof that its task finished or its reply was published. */
export function unpublishedTurns(executions: readonly SerializedAgentMessageExecution[]) {
  return executions.filter(execution => execution.state === "completed"
    && execution.inputDisposition === "submitted" && !execution.finalReply);
}
