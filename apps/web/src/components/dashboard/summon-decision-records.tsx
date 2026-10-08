"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { WEB_PROXY_ROUTES, parameterFailureCodeFromDecisionRecord, preparationFailureSummary,
  type LaunchParameterEvidence, type LaunchPlacementCandidate } from "@xmatrix/protocol";
import { formatZonedDateTime } from "./time-display";
import { fitLevel, jevDecisions, jevReadings, placementReason, placementWhere as where, roomText, type JevQuestion, type JevReading } from "./jev-decision-trace";
import { errorFromResponse } from "@/lib/query/api-client";
import { UserFacingProblem, userErrorMessage } from "@/lib/user-facing-error";

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
      if (response.status === 403 || response.status === 404) {
        throw new UserFacingProblem("Routing decisions are visible only to the summoning user.");
      }
      if (!response.ok) throw await errorFromResponse(response);
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
    } catch (failure) { setError(userErrorMessage(failure, "Couldn't load routing decisions") ?? ""); }
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

/** A routing choice, unlike a startup step, is no tick on a timeline: its
 *  label, then the option chosen in the tag a filled mention parameter wears. */
const CHOICE = "grid grid-cols-[4.75rem_minmax(0,1fr)_auto_12px] items-center gap-x-2 py-[5px]";
const OPTIONS = "m-0 mb-2 ml-[5.25rem] grid list-none gap-0.5 p-0 text-xs";

function ChosenTag({ children, routing }: { children: ReactNode; routing?: boolean }) {
  return <span className="app-summon-condition" data-jev={routing ? undefined : "true"} data-routing={routing ? "true" : undefined}>{children}</span>;
}

/** What Jev decided, one row per question in the order it answered them: the
 *  question, its answer and how sure it was. A row opens to the options it
 *  weighed; "Input" opens what it read. Jev's per-Agent fit scores are not
 *  rows of their own: with the launch's recorded placement they become one
 *  "Agent" row, the Agent and machine chosen from fit and room together. */
export function JevDecisionSection({ decisions, parameters }: { decisions: JevReading[]; parameters?: LaunchParameterEvidence }) {
  const ranking = parameters?.placement?.ranking;
  return <>{decisions.map(decision => {
    const fits = decision.questions.filter(question => question.key.startsWith("fit_"));
    const placed = ranking?.length ? ranking : undefined;
    const rows = placed ? decision.questions.filter(question => !question.key.startsWith("fit_")) : decision.questions;
    return <section key={decision.decisionId} aria-label={`Routing decision${decision.summon ? ` for ${decision.summon}` : ""}`}
      className="mt-3 border-t border-border pt-3">
      <details className="group/input">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] text-muted-foreground [&::-webkit-details-marker]:hidden">
          <span className="font-semibold uppercase tracking-wide">Routing</span>
          <span className="flex items-center gap-1">Input<ChevronRight size={12} className="transition-transform group-open/input:rotate-90" /></span>
        </summary>
        <JevInput decision={decision} />
      </details>
      <ol className="m-0 mt-1 list-none p-0" aria-label="Routing answers">
        {rows.map(question => <JevAnswer key={question.key} question={question} />)}
        {placed && <PlacementAnswer ranking={placed} compared={fits.length > 0} />}
        {decision.failure && <li className={CHOICE}><span className="text-muted-foreground">Failed</span>
          <span className="truncate text-destructive">{decision.failure}</span></li>}
      </ol>
    </section>;
  })}</>;
}

/** The Agent and machine routing chose, with the environments it weighed. */
function PlacementAnswer({ ranking, compared }: { ranking: readonly LaunchPlacementCandidate[]; compared: boolean }) {
  const chosen = ranking[0]!;
  return <li>
    <details className="group/answer">
      <summary className={`${CHOICE} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
        <span className="text-muted-foreground">Agent</span>
        <span className="truncate" title={where(chosen)}><ChosenTag routing>{chosen.harness}</ChosenTag>
          <span className="text-muted-foreground"> on </span><ChosenTag routing>{chosen.machineName || "unnamed machine"}</ChosenTag></span>
        <span />
        <ChevronRight size={12} aria-hidden="true" className="text-muted-foreground transition-transform group-open/answer:rotate-90" />
        <span />
        <span className="col-span-3 truncate text-[11px] text-muted-foreground">{placementReason(ranking, compared)}</span>
      </summary>
      <ol className={OPTIONS} aria-label="Environments weighed">
        {ranking.map((item, index) => <li key={`${item.harness}:${item.machineId}`} data-selected={index === 0 || undefined}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1 text-muted-foreground data-[selected]:bg-foreground/[0.05] data-[selected]:text-foreground">
          <span className={`truncate ${index === 0 ? "font-semibold" : ""}`}>{where(item)}</span>
          <span className="tabular-nums">{compared ? `${fitLevel(item.fit)} · ` : ""}{roomText(item.headroom)}</span>
        </li>)}
      </ol>
    </details>
  </li>;
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
      <summary className={`${CHOICE} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
        <span className="text-muted-foreground">{question.label}</span>
        <span className="truncate" title={chosen?.title}>{chosen ? <ChosenTag>{chosen.title}</ChosenTag>
          : <span className="text-muted-foreground">No answer</span>}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{percent(chosen?.probability)}</span>
        <ChevronRight size={12} aria-hidden="true" className="text-muted-foreground transition-transform group-open/answer:rotate-90" />
      </summary>
      <div className="mb-2 ml-[5.25rem] grid gap-1 text-xs">
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
