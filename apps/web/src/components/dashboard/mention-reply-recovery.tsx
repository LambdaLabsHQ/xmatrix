"use client";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SerializedAgentMessageExecution } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { recoverReply, replyRecoveryError, type ReplyRecoveryResult } from "./reply-recovery-client";
import { formatZonedDateTime } from "./time-display";
import { userErrorMessage } from "@/lib/user-facing-error";

export function MentionReplyRecovery({ execution }: { execution: SerializedAgentMessageExecution }) {
  const { user, session } = useAuth();
  if (!user || !session?.access_token || !execution.recoveryAvailable || execution.finalReply) return null;
  return <RecoveryState key={`${execution.id}:${user.id}`} execution={execution} userId={user.id} token={session.access_token} />;
}

function RecoveryState({ execution, userId, token }: { execution: SerializedAgentMessageExecution; userId: string; token: string }) {
  const fetcher = useXMatrixQueryFetch(userId);
  const queries = useQueryClient();
  const active = useRef<AbortController | null>(null);
  const pending = useRef<{ requestId: string; messageId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReplyRecoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { active.current?.abort(); pending.current = null; }, [execution.id, userId]);
  async function recover(messageId?: string) {
    if (!token || busy) return;
    const controller = new AbortController(); active.current = controller;
    if (!pending.current || pending.current.messageId !== messageId) pending.current = { requestId: crypto.randomUUID(), messageId };
    setBusy(true); setError(null);
    try {
      const value = await recoverReply(fetcher, { channelId: execution.channelId, bindingId: execution.id, token, ...pending.current }, controller.signal);
      if (controller.signal.aborted) return;
      pending.current = null; setResult(value);
      if (value.status === "committed") await queries.invalidateQueries({ queryKey: ["agent-launches", execution.channelId, `user:${userId}`] });
      else if (value.status === "unavailable") setError(replyRecoveryError(value.code));
    } catch (error) {
      if (!controller.signal.aborted) setError(userErrorMessage(error, "Couldn't confirm the recovery"));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div className="app-invocation-reply-recovery" aria-busy={busy}>
    <p className="app-invocation-description">Recover the saved reply for this input. This does not start another turn.</p>
    {result?.status === "selection_required" ? <>
      <p className="app-invocation-description">Choose the saved reply to recover:</p>
      {result.candidates.map(candidate => <button key={candidate.messageId} type="button" className="app-invocation-retry"
        disabled={busy} onClick={() => void recover(candidate.messageId)}>
        Reply from {formatZonedDateTime(new Date(candidate.createdAt * 1000).toISOString())}
      </button>)}
    </> : <button type="button" className="app-invocation-retry" disabled={busy || result?.status === "committed"}
      onClick={() => void recover()}>{busy ? "Checking saved reply…" : result?.status === "committed" ? "Reply receipt confirmed" : "Recover saved reply"}</button>}
    {error && <p role="alert" className="app-invocation-action-error">{error}</p>}
    {result?.status === "committed" && <p role="status" className="app-invocation-description">Publication confirmed. Updating this invocation’s status.</p>}
  </div>;
}
