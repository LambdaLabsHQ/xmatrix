"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { WEB_PROXY_ROUTES, parameterFailureCodeFromDecisionRecord, preparationFailureSummary } from "@xmatrix/protocol";
import { formatZonedDateTime } from "./time-display";
import { jevDecisions, jevReadings, type JevQuestion, type JevReading } from "./jev-decision-trace";

type DecisionRecord = { refId: string; createdAt: string; encodedBytes: number };
type FailureRecord = { invocationId?: unknown; status?: unknown; reason?: unknown; code?: unknown;
  answerFailure?: unknown };

/** A page holds at most 50 records; a message rarely has more than a few readings. */
const MAX_DETAILS = 50;
/** A stored record never changes, so a payload read once is kept for the page's life. */
const payloads = new Map<string, Promise<unknown>>();

function failureSummary(record: FailureRecord, invocationId: string): string | undefined {
  if (record.invocationId !== invocationId) return undefined;
  const code = parameterFailureCodeFromDecisionRecord(record);
  return code ? preparationFailureSummary(code, record.answerFailure) : undefined;
}

export type JevDecisionState = {
  route: string;
  decisions: JevReading[];
  /** The retained reason a parameter choice failed, for a rejected invocation. */
  cause?: string;
  loaded: boolean; busy: boolean; error: string;
  cursor: string | null; loadMore: () => void;
};

/** Jev's retained decisions about one message, read when the panel opens.
 *  Only the summoning user may read them; anyone else gets `error`. */
export function useJevDecisions({ channelId, messageId, sourceMention, invocationId, rejectedAt, enabled = true }: {
  channelId: string; messageId: string; sourceMention?: string; invocationId?: string; rejectedAt?: string; enabled?: boolean;
}): JevDecisionState {
  const { user } = useAuth();
  const fetcher = useXMatrixQueryFetch(user?.id ?? "");
  const [records, setRecords] = useState<Array<DecisionRecord & { payload: unknown }> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const route = WEB_PROXY_ROUTES.channel_message_decision_evidence(channelId, messageId);
  const load = useCallback(async (after: string | null) => {
    setBusy(true); setError("");
    try {
      const response = await fetcher(`${route}${after ? `?after=${encodeURIComponent(after)}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 404
        ? "Routing decisions are visible only to the summoning user." : "Routing decisions could not be loaded.");
      const result = await response.json() as { records: DecisionRecord[]; nextCursor: string | null };
      const read = await Promise.all(result.records.slice(0, MAX_DETAILS).map(async record => {
        const key = `${route}?refId=${encodeURIComponent(record.refId)}`;
        let payload = payloads.get(key);
        if (!payload) {
          payload = fetcher(key, { cache: "no-store" }).then(detail => detail.ok ? detail.json() : Promise.reject(new Error("unavailable")));
          payloads.set(key, payload);
          payload.catch(() => payloads.delete(key));
        }
        return { ...record, payload: await payload.catch(() => undefined) };
      }));
      setRecords(previous => after ? [...(previous ?? []), ...read] : read);
      setCursor(result.nextCursor);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Routing decisions could not be loaded."); }
    finally { setBusy(false); }
  }, [fetcher, route]);
  useEffect(() => { if (user && enabled) void load(null); }, [enabled, load, user]);
  // The newest retained failure for this invocation, up to the rejection it explains.
  const cutoff = rejectedAt && Number.isFinite(Date.parse(rejectedAt)) ? Date.parse(rejectedAt) : Infinity;
  const cause = invocationId ? (records ?? []).filter(record => record.refId.endsWith(":failed") &&
    Number.isFinite(Date.parse(record.createdAt)) && Date.parse(record.createdAt) <= cutoff)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map(record => failureSummary((record.payload ?? {}) as FailureRecord, invocationId)).find(Boolean) : undefined;
  const all = records ? jevDecisions(jevReadings(records)) : [];
  // A message may summon several Agents; a mention's panel keeps to its own
  // readings when Jev recorded which mention it read.
  const own = sourceMention ? all.filter(decision => decision.summon === sourceMention) : [];
  return { route, decisions: own.length ? own : all, cause, loaded: records !== null, busy, error, cursor,
    loadMore: () => { if (cursor) void load(cursor); } };
}

const percent = (value: number | undefined) => value === undefined ? "" : `${Math.round(value * 100)}%`;

/** A done or failed mark, drawn like the startup steps' marks below it. */
function Mark({ failed }: { failed?: boolean }) {
  return <span aria-hidden="true" className={`flex size-4 items-center justify-center rounded-full ${failed
    ? "border border-destructive text-destructive" : "bg-accent"}`}>{failed ? <X size={11} /> : <Check size={11} />}</span>;
}

const ROW = "grid grid-cols-[16px_4.75rem_minmax(0,1fr)_auto_12px] items-center gap-x-2 py-[5px]";

/** What Jev decided, one row per question in the order it answered them: the
 *  question, its answer and how sure it was. A row opens to the options it
 *  weighed; "Input" opens what it read. */
export function JevDecisionSection({ decisions }: { decisions: JevReading[] }) {
  return <>{decisions.map(decision => <section key={decision.decisionId} aria-label={`Routing decision${decision.summon ? ` for ${decision.summon}` : ""}`}
    className="mt-3 border-t border-border pt-3">
    <details className="group/input">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="font-semibold uppercase tracking-wide">Routing</span>
        <span className="flex items-center gap-1">Input<ChevronRight size={12} className="transition-transform group-open/input:rotate-90" /></span>
      </summary>
      <JevInput decision={decision} />
    </details>
    <ol className="m-0 mt-1 list-none p-0" aria-label="Routing answers">
      {decision.questions.map(question => <JevAnswer key={question.key} question={question} />)}
      {decision.failure && <li className={ROW}><Mark failed /><span className="text-muted-foreground">Failed</span>
        <span className="truncate text-destructive">{decision.failure}</span></li>}
    </ol>
  </section>)}</>;
}

function JevInput({ decision }: { decision: JevReading }) {
  return <div className="mt-2 grid gap-2 rounded-lg bg-foreground/[0.04] px-3 py-2 text-xs text-muted-foreground">
    {decision.message && <p className="m-0 line-clamp-6 whitespace-pre-wrap break-words text-foreground">{decision.message}</p>}
    {decision.context.length > 0 && <div className="grid gap-1">
      <p className="m-0 text-[11px] font-semibold">
        {decision.context.length} earlier {decision.context.length === 1 ? "message" : "messages"}{decision.channel && <> in #{decision.channel}</>}{decision.contextTruncated && ", more not read"}
      </p>
      <ol className="m-0 grid list-none gap-1 p-0">
        {decision.context.map((message, index) => <li key={index} className="line-clamp-2 whitespace-pre-wrap break-words"
          title={message.sentAt && formatZonedDateTime(message.sentAt)}>{message.body}</li>)}
      </ol>
    </div>}
  </div>;
}

function JevAnswer({ question }: { question: JevQuestion }) {
  const chosen = question.options.find(option => option.selected);
  return <li>
    <details className="group/answer">
      <summary className={`${ROW} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
        <Mark />
        <span className="text-muted-foreground">{question.label}</span>
        <span className="truncate font-semibold" title={chosen?.title}>{chosen?.title ?? "No answer"}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{percent(chosen?.probability)}</span>
        <ChevronRight size={12} aria-hidden="true" className="text-muted-foreground transition-transform group-open/answer:rotate-90" />
      </summary>
      <div className="mb-2 ml-6 grid gap-1 text-xs">
        <ol className="m-0 grid list-none gap-0.5 p-0" aria-label={`${question.label} options`}>
          {question.options.map(option => <li key={option.handle} data-selected={option.selected || undefined}
            className="grid grid-cols-[minmax(0,1fr)_3rem_2.25rem] items-center gap-x-2 rounded-md px-2 py-1 text-muted-foreground data-[selected]:bg-foreground/[0.05] data-[selected]:text-foreground">
            <span className={`break-words ${option.selected ? "font-semibold" : ""}`}>{option.title}</span>
            <span className="h-1 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
              <span className="block h-full rounded-full bg-foreground/50" style={{ width: percent(option.probability ?? 0) }} />
            </span>
            <span className="text-right tabular-nums">{percent(option.probability) || "—"}</span>
            {option.detail && <span className="col-span-3 line-clamp-2 break-words text-[11px] text-muted-foreground">{option.detail}</span>}
          </li>)}
        </ol>
        {question.model && <p className="m-0 px-2 text-[11px] leading-snug text-muted-foreground">
          <span className="font-semibold">Decided by: </span>{question.model}</p>}
        {question.instructions && <p className="m-0 px-2 text-[11px] leading-snug text-muted-foreground" title={question.instructions}>
          <span className="font-semibold">Asked: </span><span className="line-clamp-2 inline">{question.instructions}</span></p>}
      </div>
    </details>
  </li>;
}

/** The raw records behind the timeline, folded into the panel's Details. */
export function JevDecisionFiles({ state }: { state: JevDecisionState }) {
  if (state.error) return <p className="app-invocation-description">{state.error}</p>;
  const refs = state.decisions.flatMap(decision => decision.refs);
  if (!refs.length && !state.cursor) return null;
  return <p className="app-invocation-description">
    Routing records (kept 30 days):{" "}
    {refs.map((refId, index) => <span key={refId}>{index > 0 && " · "}
      <a className="underline" href={`${state.route}?refId=${encodeURIComponent(refId)}`} download="summon-decision.json">
        {refId.endsWith(":started") ? "input" : refId.endsWith(":failed") ? "failure" : "result"}
      </a>
    </span>)}
    {state.cursor && <> · <button type="button" className="cursor-pointer underline" disabled={state.busy} onClick={state.loadMore}>
      {state.busy ? "loading…" : "load earlier"}</button></>}
  </p>;
}
