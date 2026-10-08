"use client";

import { useEffect, useState } from "react";
import { preparationFailureSummary, type InteractionDecisionWindow, type InteractionLaunchOption } from "@xmatrix/protocol";
import { avatarImageSrc } from "./identity-avatar";
import { launchChoiceRead, launchChoiceView, type LaunchChoiceView } from "./first-message-launch-choice-state";

/** The option's own icon, from its launch option; never rebuilt from the harness name here. */
function OptionMark({ option }: { option: InteractionLaunchOption }) {
  const icon = avatarImageSrc(option.iconRef);
  return icon
    // eslint-disable-next-line @next/next/no-img-element -- an 18px harness preset icon, as on summon chips.
    ? <img src={icon} alt="" aria-hidden="true" className="launch-choice-icon" />
    : <span aria-hidden="true" className="launch-choice-icon launch-choice-icon-blank" />;
}

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
const failureNote = (code: string) => preparationFailureSummary(code) ?? code;

/**
 * After a new conversation's first message, once its words and pictures are
 * already together. The card offers the harnesses its author may start, and
 * "Don't start". The author may pick at once; once Jev's reading appears they
 * have three seconds to pick something else before it decides. Afterwards the
 * card is one quiet line saying what was picked; the picked harness is
 * summoned by an `@<harness>` reply, which shows its own launch.
 */
/** When Jev's reading first appeared on its author's screen, kept across
 * remounts (the timeline is virtualized) so a row scrolled away and back
 * neither restarts its window nor tells the Hub twice. */
const seenAtByMessage = new Map<string, number>();

export function FirstMessageLaunchChoice({ messageId, window, offeredAt, own, options, onChoose, onShown }: {
  messageId: string;
  /** The Hub's decision window (`launch-choice.v1`), once its record arrives. */
  window?: InteractionDecisionWindow;
  /** The author's own fresh first message, offered before the Hub's record arrives. */
  offeredAt?: string;
  own: boolean;
  /** What the reader may start, for the author's card before the Hub's record arrives. */
  options: readonly InteractionLaunchOption[];
  onChoose: (harness: string | null) => Promise<void>;
  /** Tells the Hub the author now sees Jev's reading, so the window runs from here. */
  onShown: () => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [ticking, setTicking] = useState(true);
  const [seenAt, setSeenAt] = useState<number | undefined>(() => seenAtByMessage.get(messageId));
  const now = useNow(ticking);
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
  if (view.kind === "hidden") return null;

  if (view.kind === "open" || view.kind === "reading") {
    const recommended = view.recommended;
    const remaining = view.kind === "open" && view.deadlineAt !== undefined ? Math.max(0, view.deadlineAt - now) : undefined;
    const choosing = view.kind === "open" && own && pending === undefined;
    const choose = async (harness: string | null) => {
      setPending(harness);
      setError(null);
      try { await onChoose(harness); }
      catch (failure) { setPending(undefined); setError((failure as Error).message); }
    };
    // The window lists Jev's pick even when the reader's catalog has not loaded yet.
    const listed = window?.options.length ? window.options : options;
    return (
      <div className="launch-choice" data-state={view.kind} role="group" aria-label="Choose the Agent that starts">
        <div className="launch-choice-row">
          <span className="launch-choice-label">
            {view.kind === "reading" ? "xMatrix is deciding" : remaining === undefined ? "xMatrix is reading" : "Start"}
          </span>
          <div className="launch-choice-options">
            {listed.map(option => (
              <button key={option.optionId} type="button" className="launch-choice-option"
                data-recommended={recommended === option.optionId || undefined}
                data-picked={pending === option.harness || undefined}
                disabled={!choosing} onClick={() => void choose(option.harness)}
                aria-label={`Start ${option.displayName}${recommended === option.optionId ? " (xMatrix's pick)" : ""}`}>
                <OptionMark option={option} />
                <span>{option.displayName}</span>
                {recommended === option.optionId && <span className="launch-choice-jev">xMatrix</span>}
              </button>
            ))}
          </div>
          {own && view.kind === "open" && (
            <button type="button" className="launch-choice-skip" data-recommended={recommended === null || undefined}
              data-picked={pending === null || undefined} disabled={!choosing} onClick={() => void choose(null)}>
              Don&apos;t start
            </button>
          )}
          {remaining !== undefined && (
            <span className="launch-choice-count" aria-live="off">{Math.ceil(remaining / 1000)}</span>
          )}
        </div>
        {remaining !== undefined && view.kind === "open" && (
          // Keyed by deadline so the drain restarts only if the window moves.
          <span key={view.deadlineAt} className="launch-choice-drain" aria-hidden="true"
            style={{ animationDuration: `${remaining}ms` }} />
        )}
        {error && <p role="alert" className="launch-choice-error">{error}</p>}
      </div>
    );
  }
  return <DecidedLaunchChoice view={view} own={own} />;
}

function DecidedLaunchChoice({ view, own }: { view: Extract<LaunchChoiceView, { kind: "chosen" | "none" }>; own: boolean }) {
  const by = view.by === "jev" ? "xMatrix's pick" : own ? "Your pick" : "Author's pick";
  if (view.kind === "none") {
    return (
      <div className="launch-choice launch-choice-settled" data-state="none" role="status">
        <span className="launch-choice-label">No Agent started</span>
        <span className="launch-choice-note">
          {view.failureCode ? failureNote(view.failureCode) : view.by === "jev" ? "xMatrix read this as conversation" : by}
        </span>
      </div>
    );
  }
  return (
    <div className="launch-choice launch-choice-settled" data-state="chosen" role="status">
      <span className="launch-choice-agent"><OptionMark option={view.option} />{view.option.displayName}</span>
      <span className="launch-choice-note">{by}</span>
    </div>
  );
}
