"use client";

import { useEffect, useRef, useState } from "react";
import { Layers, SquareTerminal, type LucideIcon } from "lucide-react";
import type { AgentRuntimeWaiting } from "@xmatrix/protocol";

import { cn } from "@/lib/utils";
import { statusInkClass } from "@/components/ui/status-tone";
import { useDecorationSpin, useDecorationAnimationGroup } from "@/components/ui/decoration-animation";
import type { AgentWorkItem } from "./workspace-shell-message-model";

/**
 * The Now line in the work dock (docs/design/conversation-activity.md §4.2):
 * the step an Instance's own plan says it is on. When that step has not
 * changed for a while and the Instance still reports busy, the line turns to
 * the attention colour, so silence is visible instead of hidden behind a
 * green status. While the runtime reports a wait, the line says what the
 * Instance waits on and for how long instead.
 */
export const INTENT_STALE_MS = 5 * 60 * 1000;
const TICK_MS = 30_000;

/** When each Instance's current intent was first seen by this client. */
export function useIntentSince(items: readonly Pick<AgentWorkItem, "key" | "intent">[]): ReadonlyMap<string, number> {
  const seen = useRef(new Map<string, { intent: string; since: number }>());
  const [since, setSince] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    const now = Date.now();
    const next = new Map<string, { intent: string; since: number }>();
    for (const item of items) {
      if (!item.intent) continue;
      const previous = seen.current.get(item.key);
      next.set(item.key, previous?.intent === item.intent ? previous : { intent: item.intent, since: now });
    }
    const changed = seen.current.size !== next.size ||
      [...next].some(([key, value]) => seen.current.get(key)?.since !== value.since);
    seen.current = next;
    // An external-store update can leave work on this fiber's alternate, so
    // even a setter returning the same state may schedule another commit.
    if (changed) setSince(new Map([...next].map(([key, value]) => [key, value.since])));
  }, [items]);
  return since;
}

export function useNow(intervalMs = TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Waiting on CI or a build is normal, so a wait turns to the attention colour
 * only once it has gone on far longer than silence while working may
 * (docs/design/agent-status.md).
 */
export const WAITING_STALE_MS = 30 * 60 * 1000;

/** "waiting: cargo test · 4m": what a waiting Instance waits on, and for how long. */
export function agentWaitingPhrase(waiting: AgentRuntimeWaiting, now: number): string {
  return `waiting: ${agentWaitingSubject(waiting).word} · ${elapsedLabel(now - waiting.sinceMillis)}`;
}

/** What the plaque names after "Waiting": the runtime's label as it is, with its kind's icon. */
export function agentWaitingSubject(waiting: AgentRuntimeWaiting): { word: string; icon: LucideIcon } {
  const background = waiting.kind === "background";
  return { word: waiting.label || (background ? "tasks" : "a tool call"), icon: background ? Layers : SquareTerminal };
}

function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The island's content (docs/design/agent-status.md §2): while the runtime
 * reports a wait, "Waiting" and what it waits on; otherwise the intent.
 * A small timer ring at the trailing end keeps turning. Its arc grows toward
 * the point where the island turns to the attention ink; the elapsed time
 * sits beside it.
 */
export function AgentWorkIntent({
  intent,
  since,
  now,
  busy,
  waiting,
}: {
  intent?: string;
  since: number | undefined;
  now: number;
  busy: boolean;
  /** Present while the Instance's runtime reports it is waiting. */
  waiting?: AgentRuntimeWaiting;
}) {
  const quietFor = since === undefined ? 0 : Math.max(0, now - since);
  const minutes = Math.floor(quietFor / 60_000);
  const waitingPhrase = waiting ? agentWaitingPhrase(waiting, now) : undefined;
  const elapsed = waiting ? Math.max(0, now - waiting.sinceMillis) : quietFor;
  const limit = waiting ? WAITING_STALE_MS : INTENT_STALE_MS;
  const timed = Boolean(waiting) || busy;
  const stale = timed && elapsed >= limit;
  const label = waitingPhrase
    ? (intent ? `${intent} · ${waitingPhrase}` : capitalized(waitingPhrase))
    : stale ? `${intent} · unchanged for ${minutes}m` : intent;
  const subject = waiting ? agentWaitingSubject(waiting) : undefined;
  // The words are read out whole here; the pointer reads them, and what a
  // wait is on in particular, on the hover card (AgentWorkIntentCard).
  return (
    <span
      className={cn("app-agent-work-intent", stale && "app-agent-work-intent-stale")}
      aria-label={label}
    >
      <span className="app-agent-work-intent-text">
        {subject ? (
          <>
            <span className="app-agent-work-intent-caption">Waiting</span>
            <span className="app-agent-work-intent-main">
              <subject.icon className="size-3.5 shrink-0" aria-hidden="true" />
              <IntentInk text={subject.word} animated={!stale} />
            </span>
          </>
        ) : (
          <>
            {busy && <span className="app-agent-work-intent-caption">Working on</span>}
            <span className="app-agent-work-intent-main"><IntentInk text={intent} animated={!stale} /></span>
          </>
        )}
      </span>
      {timed && (
        <span className="app-agent-work-intent-timer">
          <TimerRing fraction={Math.min(1, elapsed / limit)} />
          <span className="tabular-nums">{elapsedLabel(elapsed)}</span>
        </span>
      )}
    </span>
  );
}

/** The ink stays in place while a feathered window carries the highlight.
 * Its duplicate is a hidden paint layer, never a second accessible label. */
function createIntentInkEffects(element: HTMLElement): readonly KeyframeEffect[] {
  const window = element.querySelector<HTMLElement>(".app-agent-work-intent-ink-window");
  const shine = element.querySelector<HTMLElement>(".app-agent-work-intent-ink-shine");
  if (!window || !shine) return [];
  const timing: KeyframeEffectOptions = { duration: 2200, iterations: Infinity, easing: "linear" };
  return [
    new KeyframeEffect(window, [{ transform: "translateX(0)" }, { transform: "translateX(333.333333%)" }], timing),
    new KeyframeEffect(shine, [{ transform: "translateX(80%)" }, { transform: "translateX(-120%)" }], timing),
  ];
}

function intentInkVisibility(element: HTMLElement) {
  return {
    element: element.closest<HTMLElement>(".app-agent-work-item") ?? element,
    root: element.closest<HTMLElement>(".app-agent-work-scroller"),
  };
}

function IntentInk({ text, animated }: { text: string | undefined; animated: boolean }) {
  const animationRef = useDecorationAnimationGroup(createIntentInkEffects, animated, intentInkVisibility);
  return <span ref={animationRef} className="app-agent-work-intent-ink truncate">
    <span className="app-agent-work-intent-ink-base">{text}</span>
    <span className="app-agent-work-intent-ink-window" aria-hidden="true">
      <span className="app-agent-work-intent-ink-shine" data-ink={text} />
    </span>
  </span>;
}

/**
 * The island's own hover card, apart from the Instance's controls: what a
 * wait is on in particular (the descriptions the runtime carries) and since
 * when; otherwise the whole step it is on, and how long it has not changed.
 */
export function AgentWorkIntentCard({ intent, since, now, busy, waiting }: {
  intent?: string;
  since: number | undefined;
  now: number;
  busy: boolean;
  waiting?: AgentRuntimeWaiting;
}) {
  if (waiting) {
    const subject = agentWaitingSubject(waiting);
    const stale = now - waiting.sinceMillis >= WAITING_STALE_MS;
    return (
      <>
        <span className={cn("app-agent-work-hover-title", stale && statusInkClass("attention"))}>
          <subject.icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{subject.word}</span>
          <span className="app-agent-work-hover-meta">
            {elapsedLabel(now - waiting.sinceMillis)} · since {clockLabel(waiting.sinceMillis)}
          </span>
        </span>
        {waiting.details?.map((detail, index) => (
          <span key={index} className="app-agent-work-hover-line">{detail}</span>
        ))}
        {intent && <span className="app-agent-work-hover-line app-agent-work-hover-quiet">{intent}</span>}
      </>
    );
  }
  const quietFor = since === undefined ? 0 : Math.max(0, now - since);
  return (
    <>
      {busy && <span className="app-agent-work-hover-meta">Working on</span>}
      <span className="app-agent-work-hover-line">{intent}</span>
      {busy && (
        <span className={cn("app-agent-work-hover-meta", quietFor >= INTENT_STALE_MS && statusInkClass("attention"))}>
          Unchanged for {elapsedLabel(quietFor)}
        </span>
      )}
    </>
  );
}

function clockLabel(millis: number): string {
  return new Date(millis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const TIMER_RADIUS = 7;
const TIMER_CIRCUMFERENCE = 2 * Math.PI * TIMER_RADIUS;

function TimerRing({ fraction }: { fraction: number }) {
  // Arc length is the elapsed share of the attention threshold. The ring
  // itself turns; reduced motion leaves the arc parked at 12 o'clock.
  const animationRef = useDecorationSpin();
  return (
    <span ref={animationRef} className="app-agent-work-intent-ring" aria-hidden="true">
      <svg className="app-agent-work-intent-ring-face" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={TIMER_RADIUS} />
        <circle cx="9" cy="9" r={TIMER_RADIUS} transform="rotate(-90 9 9)"
          strokeDasharray={`${fraction * TIMER_CIRCUMFERENCE} ${TIMER_CIRCUMFERENCE}`} />
      </svg>
    </span>
  );
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
