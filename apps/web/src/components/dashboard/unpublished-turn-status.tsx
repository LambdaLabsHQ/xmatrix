"use client";
import type { SerializedAgentMessageExecution } from "@xmatrix/protocol";
import { unpublishedTurns } from "./unpublished-turn-state";
import { MentionReplyRecovery } from "./mention-reply-recovery";

export function UnpublishedTurnState({ executions, unavailable }: {
  executions: readonly SerializedAgentMessageExecution[]; unavailable?: boolean;
}) {
  return <>{unpublishedTurns(executions).map(execution => <div key={execution.id}
    className="mt-2 text-xs text-muted-foreground" role="status">
    <p>{execution.agentName || "Agent"} finished a turn. No final channel reply is confirmed.
      {unavailable && " Status could not be refreshed."}</p>
    {!unavailable && <MentionReplyRecovery execution={execution} />}
  </div>)}</>;
}
