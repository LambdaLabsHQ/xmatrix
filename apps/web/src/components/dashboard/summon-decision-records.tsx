"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { WEB_PROXY_ROUTES, parameterFailureCodeFromDecisionRecord, preparationFailureSummary } from "@xmatrix/protocol";
import { formatZonedDateTime } from "./time-display";

type DecisionRecord = { refId: string; createdAt: string; encodedBytes: number };
type FailureRecord = { invocationId?: unknown; status?: unknown; reason?: unknown; code?: unknown;
  answerFailure?: unknown };

function failureSummary(record: FailureRecord, invocationId: string): string | undefined {
  if (record.invocationId !== invocationId) return undefined;
  const code = parameterFailureCodeFromDecisionRecord(record);
  return code ? preparationFailureSummary(code, record.answerFailure) : undefined;
}

export function SummonDecisionRecords({ channelId, messageId, invocationId, rejectedAt }: {
  channelId: string; messageId: string; invocationId?: string; rejectedAt?: string;
}) {
  const { user } = useAuth();
  return user ? <DecisionRecordsState key={user.id} channelId={channelId} messageId={messageId}
    invocationId={invocationId} rejectedAt={rejectedAt} userId={user.id} /> : null;
}

function DecisionRecordsState({ channelId, messageId, invocationId, rejectedAt, userId }: {
  channelId: string; messageId: string; invocationId?: string; rejectedAt?: string; userId: string;
}) {
  const fetcher = useXMatrixQueryFetch(userId);
  const [records, setRecords] = useState<DecisionRecord[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cause, setCause] = useState("");
  const bestFailureAt = useRef(-Infinity);
  const route = WEB_PROXY_ROUTES.channel_message_decision_evidence(channelId, messageId);
  const load = useCallback(async (after: string | null) => {
    setBusy(true); setError("");
    try {
      const response = await fetcher(`${route}${after ? `?after=${encodeURIComponent(after)}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 404
        ? "Decision records are unavailable for your account." : "Decision records could not be loaded.");
      const result = await response.json() as { records: DecisionRecord[]; nextCursor: string | null };
      setRecords(previous => after ? [...(previous ?? []), ...result.records] : result.records);
      setCursor(result.nextCursor);
      if (invocationId) {
        const rejectionTime = rejectedAt ? Date.parse(rejectedAt) : NaN;
        const cutoff = Number.isFinite(rejectionTime) ? rejectionTime : Infinity;
        const failed = result.records.filter(item => item.refId.endsWith(":failed") &&
          Number.isFinite(Date.parse(item.createdAt)) && Date.parse(item.createdAt) <= cutoff)
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
        for (const record of failed) {
          const detail = await fetcher(`${route}?refId=${encodeURIComponent(record.refId)}`, { cache: "no-store" });
          if (!detail.ok) continue;
          const summary = failureSummary(await detail.json() as FailureRecord, invocationId);
          if (summary && Date.parse(record.createdAt) > bestFailureAt.current) {
            bestFailureAt.current = Date.parse(record.createdAt);
            setCause(summary);
            break;
          }
        }
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Decision records could not be loaded."); }
    finally { setBusy(false); }
  }, [fetcher, invocationId, rejectedAt, route]);
  useEffect(() => {
    bestFailureAt.current = -Infinity;
    setCause("");
    if (invocationId) void load(null);
  }, [invocationId, load]);
  return <div className="app-invocation-request">
    {invocationId && (cause ? <p role="status">Cause: {cause}</p>
      : busy ? <p>Checking failure reason…</p>
        : records && !cursor && !error ? <p>Detailed failure reason was not retained.</p> : null)}
    {error && <p role="status">{error}</p>}
    <details>
      <summary>Decision records</summary>
      {(records === null || cursor) && <button type="button" disabled={busy} onClick={() => void load(cursor)}>
        {busy ? "Loading records…" : records === null ? "View decision records" : "Load more records"}
      </button>}
      {records && <>
        <p>Available to the summoning user for 30 days.</p>
        {records.length === 0 ? <p>No decision records are retained.</p> : <ul>
          {records.map(record => <li key={record.refId}>
            <a href={`${route}?refId=${encodeURIComponent(record.refId)}`} download="summon-decision.json">
              {record.refId.endsWith(":started") ? "Input" : record.refId.endsWith(":failed") ? "Failure" : "Result"}
              {" · "}{formatZonedDateTime(record.createdAt)}
            </a>
          </li>)}
        </ul>}
      </>}
    </details>
  </div>;
}
