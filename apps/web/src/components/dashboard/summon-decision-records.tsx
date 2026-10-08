"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { WEB_PROXY_ROUTES, parameterFailureCodeFromDecisionRecord, preparationFailureSummary,
  type LaunchParameterEvidence } from "@xmatrix/protocol";
import { formatZonedDateTime } from "./time-display";
import { fitLevel, jevDecisions, jevReadings, placementReason, roomText, type JevReading } from "./jev-decision-trace";
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

/** A routing question is a choice, not a step: its options are listed with
 *  radio marks, the chosen one filled, so it never reads like the ticked
 *  startup timeline below it. */
type ChoiceOption = { key: string; title: string; subtitle?: string; meta?: string; chosen: boolean };
const SHOWN_OPTIONS = 3;
// Arbitrary radius and edge: the app-wide `.rounded-lg.border` rule would turn a card into glass.
const CARD = "grid min-w-0 content-start gap-0.5 rounded-[10px] border-[1px] px-2.5 py-2 text-left";

/** One routing question as a set of option cards: each card is a candidate,
 *  the chosen one drawn with a darker edge and a faint fill, the rest faint. */
function RoutingChoice({ label, options, note, hint }: { label: string; options: readonly ChoiceOption[]; note?: string; hint?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? options : options.slice(0, SHOWN_OPTIONS);
  const hidden = options.length - shown.length;
  return <li className="grid gap-1.5 py-1.5" aria-label={label}>
    <span className="text-[11px] text-muted-foreground" title={hint}>{label}</span>
    <ul className="m-0 grid list-none grid-cols-3 gap-1.5 p-0" aria-label={`${label} options`}>
      {shown.map(option => <li key={option.key} data-selected={option.chosen || undefined}
        className={`${CARD} border-solid ${shown.length === 1 && !hidden ? "col-span-3" : ""} ${option.chosen ? "border-foreground/45 bg-foreground/[0.04] text-foreground" : "border-border text-muted-foreground"}`}>
        <span className={`truncate ${option.chosen ? "font-semibold" : "font-medium"}`} title={option.title}>{option.title}</span>
        {option.subtitle && <span className="truncate text-[11px]" title={option.subtitle}>{option.subtitle}</span>}
        {option.meta && <span className="truncate text-[11px] tabular-nums">{option.meta}</span>}
      </li>)}
      {hidden > 0 && <li className="contents"><button type="button" onClick={() => setAll(true)}
        className={`${CARD} cursor-pointer place-content-center border-dashed border-border text-[11px] text-muted-foreground hover:text-foreground`}>
        {hidden} more</button></li>}
    </ul>
    {note && <p className="m-0 text-[11px] leading-snug text-muted-foreground">{note}</p>}
  </li>;
}

/** What routing chose, one choice per question in the order it was answered:
 *  the options weighed, the chosen one marked, with how sure Jev was or how
 *  each environment measured. "Input" opens what Jev read. Its per-Agent fit scores are not
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
        {rows.map(question => <RoutingChoice key={question.key} label={question.label} hint={question.instructions}
          options={question.options.map(option => ({ key: option.handle, title: option.title, meta: percent(option.probability), chosen: option.selected }))} />)}
        {placed && <RoutingChoice label="Agent" note={placementReason(placed, fits.length > 0)}
          options={placed.map((item, index) => ({ key: `${item.harness}:${item.machineId}`, title: item.harness,
            subtitle: item.machineName || "unnamed machine", chosen: index === 0,
            meta: `${fits.length > 0 ? `${fitLevel(item.fit)} · ` : ""}${roomText(item.headroom)}` }))} />}
        {decision.failure && <li className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-2 py-1.5"><span className="text-muted-foreground">Failed</span>
          <span className="truncate text-destructive">{decision.failure}</span></li>}
      </ol>
    </section>;
  })}</>;
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
