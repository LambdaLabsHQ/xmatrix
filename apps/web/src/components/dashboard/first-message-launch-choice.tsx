"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReaderLocale } from "@/lib/onboarding-locale";
import { launchRejectionCause, type ProblemLocale, type InteractionDecisionWindow, type InteractionLaunchOption } from "@xmatrix/protocol";
import { LaunchAgentMenu, OptionMark } from "./launch-agent-menu";
import { launchChoiceRead, launchChoiceView } from "./first-message-launch-choice-state";
import { userErrorMessage } from "@/lib/user-facing-error";

/** Re-render on a short tick only while the window is open. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Why nothing could start, in words; an unknown code is shown as it is. */
const failureNote = (code: string, locale: ProblemLocale) => code === "message_ask_stopped"
  ? (locale === "zh" ? "Agent 启动前就停下了" : "Stopped before the Agent started") : launchRejectionCause(code, locale) ?? code;

/** When Jev's reading first appeared on its author's screen, kept across
 * remounts (the timeline is virtualized) so a row scrolled away and back
 * neither restarts its window nor tells the Hub twice. */
const seenAtByMessage = new Map<string, number>();

/** First messages whose author just summoned an Agent from the line's menu:
 * the summon they sent says the rest, so the line is gone before it lands. */
const summonedByMessage = new Set<string>();

/**
 * Under a new conversation's first message, once its words and pictures are
 * together: one line of text saying what is about to happen to it ("Choosing an Agent…",
 * said as the outcome the author waits for, not as what xMatrix does inside), and
 * the author's two ways out. It is a sentence, not a card and not a list of
 * Agents: most authors read it and do nothing.
 *
 * The author may say "Don't start", or open the menu to choose. Opening the
 * menu takes the decision from xMatrix at once (the Hub records "start
 * nothing"), so choosing is never a race against the three-second window:
 * the Agent picked there is summoned by the author's own `@<harness>` message,
 * and "Model, effort, machine…" hands that summon to the composer. Jev's pick
 * is summoned by xMatrix's `@<harness>` reply. Either summon shows the launch
 * and whose it was, so once anything follows the message the line is gone.
 */
export function FirstMessageLaunchChoice({ messageId, window, offeredAt, own, followed, options, onChoose, onShown, onSummon, onCompose }: {
  messageId: string;
  /** The Hub's decision window (`launch-choice.v1`), once its record arrives. */
  window?: InteractionDecisionWindow;
  /** The author's own fresh first message, offered before the Hub's record arrives. */
  offeredAt?: string;
  own: boolean;
  /** Something follows the message in the conversation. */
  followed: boolean;
  /** What the reader may start, for the author's line before the Hub's record arrives. */
  options: readonly InteractionLaunchOption[];
  onChoose: (harness: string | null) => Promise<void>;
  /** Tells the Hub the author now sees Jev's reading, so the window runs from here. */
  onShown: () => Promise<void>;
  /** Sends the author's own summon, as the composer would. */
  onSummon?: (body: string) => Promise<void>;
  /** Puts `@<mention>` in the composer for the author to finish. */
  onCompose?: (mention: string) => void;
}) {
  const locale = useReaderLocale();
  const line = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [summoned, setSummoned] = useState(() => summonedByMessage.has(messageId));
  const [error, setError] = useState<string | null>(null);
  const [ticking, setTicking] = useState(true);
  const [seenAt, setSeenAt] = useState<number | undefined>(() => seenAtByMessage.get(messageId));
  const now = useNow(ticking);
  const closeMenu = useCallback(() => setMenu(false), []);
  // The author's three seconds start when Jev's reading reaches them while the
  // Hub still holds the choice open; an old conversation never reopens.
  const seeing = own && !window?.decision && window?.open === true && launchChoiceRead(window);
  useEffect(() => {
    if (!seeing || seenAt !== undefined) return;
    const known = seenAtByMessage.get(messageId);
    if (known !== undefined) { setSeenAt(known); return; }
    const at = Date.now();
    seenAtByMessage.set(messageId, at);
    setSeenAt(at);
    void onShown().catch(() => undefined);
  }, [seeing, seenAt, onShown, messageId]);
  const view = launchChoiceView(window, { sentAt: offeredAt, ...(own ? { seenAt } : {}) }, now);
  useEffect(() => { setTicking(view.kind === "open"); }, [view.kind]);
  if (view.kind === "hidden" || summoned) return null;
  // What was decided is said by what follows: the summon, or the conversation going on.
  if (followed && (view.kind === "chosen" || view.kind === "none")) return null;

  // The window lists Jev's pick even when the reader's catalog has not loaded yet.
  const listed = window?.options.length ? window.options : options;
  const undecided = view.kind === "open" || view.kind === "reading";
  const recommended = undecided ? view.recommended : undefined;
  const pick = typeof recommended === "string" ? listed.find(option => option.optionId === recommended) : undefined;
  const remaining = view.kind === "open" && view.deadlineAt !== undefined ? Math.max(0, view.deadlineAt - now) : undefined;
  const acting = own && !pending && (view.kind === "open" || view.kind === "none");
  const canAsk = acting && listed.length > 0 && onSummon !== undefined;

  const decline = async () => {
    setPending(true);
    setError(null);
    try { await onChoose(null); }
    catch (failure) { setError(userErrorMessage(failure, "That didn't work")); }
    finally { setPending(false); }
  };
  // Choosing takes the decision first, so nothing starts while the menu is open.
  const choose = async () => {
    if (view.kind === "open") {
      setPending(true);
      setError(null);
      try { await onChoose(null); }
      catch (failure) { setError(userErrorMessage(failure, "That didn't work")); return; }
      finally { setPending(false); }
    }
    setMenu(true);
  };
  const summon = async (option: InteractionLaunchOption) => {
    summonedByMessage.add(messageId);
    setSummoned(true);
    try { await onSummon?.(`@${option.harness}`); }
    catch (failure) {
      summonedByMessage.delete(messageId);
      setSummoned(false);
      setError(userErrorMessage(failure, "Couldn't start the Agent"));
    }
  };

  const cause = view.kind !== "none" ? undefined
    : view.failureCode ? failureNote(view.failureCode, locale)
    : view.by === "jev" ? "xMatrix read this as conversation" : undefined;
  const status = menu && canAsk ? "Choose who starts"
    : view.kind === "chosen" ? <><Agent option={view.option} /> is starting</>
    : view.kind === "none" ? (cause ? `No Agent started · ${cause}` : "No Agent started")
    : pick ? <><Agent option={pick} /> {remaining !== undefined
      ? <>starts in <span className="launch-line-count">{Math.ceil(remaining / 1000)}s</span></> : "is starting"}</>
    : recommended === null ? "Read as conversation, so no Agent starts"
    : "Choosing an Agent…";
  const live = undecided && !pick && recommended !== null;
  // Jev could not read it, or read it as conversation: the same exit either way.
  const asking = view.kind === "none" || recommended === null;
  return (
    <div ref={line} className="launch-line" data-state={view.kind} data-live={live || undefined}
      role={undecided ? "group" : "status"} aria-label={undecided ? "The Agent that starts" : undefined}>
      <span className="launch-line-status">{status}</span>
      {!menu && canAsk && !asking && (
        <button type="button" className="launch-line-action" aria-haspopup="menu" aria-expanded={menu} onClick={() => void choose()}>
          {pick ? "Change" : "Pick one"}
        </button>
      )}
      {!menu && canAsk && asking && (
        <button type="button" className="launch-line-action" aria-haspopup="menu" aria-expanded={menu} onClick={() => void choose()}>
          Ask an Agent
        </button>
      )}
      {!menu && acting && view.kind === "open" && !asking && (
        <button type="button" className="launch-line-action" onClick={() => void decline()}>Don&apos;t start</button>
      )}
      {error && <span role="alert" className="launch-line-error">{error}</span>}
      {menu && canAsk && line.current && (
        <LaunchAgentMenu anchor={line.current} label="Choose the Agent that starts" options={listed}
          recommended={window?.recommendation} onPick={option => void summon(option)} onClose={closeMenu}
          onCompose={onCompose ? () => onCompose(typeof window?.recommendation === "string"
            ? listed.find(option => option.optionId === window.recommendation)?.harness ?? "auto" : "auto") : undefined} />
      )}
    </div>
  );
}

/** An Agent named in the line: its mark and its name, in ink. */
function Agent({ option }: { option: InteractionLaunchOption }) {
  return <span className="launch-line-agent"><OptionMark option={option} />{option.displayName}</span>;
}
