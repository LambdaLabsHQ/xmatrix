"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MESSAGE_JUMP_SETTLE_FRAMES } from "./workspace-shell-constants";
import { resolveTimelineAnchor, timelineRowIsOnScreen } from "./workspace-shell-helpers";
import { clearBrowserHash } from "./workspace-shell-navigation";
import type { TimelineJumpHandle, TimelineJumpOutcome } from "./workspace-message-timeline";

/* Jumping to a message is a small state machine, and it used to be smeared
   across two five-thousand-line hooks, which is a large part of why it was
   wrong in three separate ways. It lives here as one piece: arm an intent,
   reach the target (page or seek), land it, and only then consume the intent.

   Two rules hold the whole thing together:

   - A URL hash is an intent, never a landing. The hash cannot scroll a
     virtualized list, because a row outside the rendered window has no element
     for the browser to find.
   - A landing is something observed, never something assumed. Asking the
     virtualizer to scroll is not the same as the row being on screen, and the
     difference is a whole animation frame - or several, when the row arrived
     with a history page the virtualizer has not ingested yet. */

/** One armed jump. `requestId` is its generation, used only for identity. */
export type MessageJumpIntent = {
  channelId: string;
  messageId: string;
  requestId: number;
  sequence?: number;
};

export const MESSAGE_JUMP_HIGHLIGHT_MS = 6_000;

export function useMessageJump({
  timelineScrollRef,
  setBrowserHash,
}: {
  timelineScrollRef: React.RefObject<HTMLDivElement | null>;
  setBrowserHash: (hash: string) => void;
}) {
  /* In-app jumps (reply previews, follow-ups, search, internal links) must not
     rely on browserHash alone: the hash is cleared after a landing so later
     timeline updates do not re-stick, so a second jump on an already-open
     channel has to arm a distinct intent. The optional sequence lets the reach
     step seek the target's neighbourhood instead of walking backward page by
     page from the live tail. */
  const pendingMessageJumpRef = useRef<MessageJumpIntent | null>(null);

  /** Generation of the newest intent. Identity only — never a render trigger. */
  const messageJumpRequestIdRef = useRef(0);

  /** requestId currently running a sequence seek (0 = idle). */
  const messageJumpSeekInFlightRef = useRef(0);

  /** requestId whose sequence seek already finished (success or empty). */
  const messageJumpSeekAttemptedRef = useRef(0);

  /* Re-run ticker for the landing effect, deliberately separate from the
     generation id above. Sharing one number let a new intent land on the value
     a settle retry had already ticked to; React then bailed out of the render
     and the armed intent was never run — the jump silently did nothing.
     Identity and revision answer different questions, so they do not share a
     namespace. Every writer ticks; nobody assigns. */
  const [messageJumpRevision, setMessageJumpRevision] = useState(0);

  /* The only way to move the revision. The setter never leaves this module, so
     assigning a generation id to it - the bug that stranded an armed intent
     because React bailed out of the render - is not expressible at the call
     sites at all, rather than merely discouraged there. */
  const bumpMessageJumpRevision = useCallback(() => {
    setMessageJumpRevision((current) => current + 1);
  }, []);

  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightedMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Published by the timeline; the only thing that can place a virtualized row. */
  const timelineJumpRef = useRef<TimelineJumpHandle | null>(null);
  const messageJumpSettleRef = useRef<{
    requestId: number;
    frames: number;
    frame: number | null;
  }>({ requestId: 0, frames: 0, frame: null });

  /* Own the teardown rather than leaning on React tolerating a state update
     after unmount. The generation guard alone is not enough here: an unmount
     leaves the current intent in the ref, so a frame already queued would pass
     that guard and set state on a hook that no longer exists. */
  useEffect(() => {
    const settle = messageJumpSettleRef.current;
    return () => {
      if (highlightedMessageTimerRef.current) {
        clearTimeout(highlightedMessageTimerRef.current);
        highlightedMessageTimerRef.current = null;
      }
      if (settle.frame !== null) {
        window.cancelAnimationFrame(settle.frame);
        settle.frame = null;
      }
    };
  }, []);

  const armMessageJumpHighlight = useCallback((messageId: string) => {
    setHighlightedMessageId(messageId);
    if (highlightedMessageTimerRef.current) {
      clearTimeout(highlightedMessageTimerRef.current);
    }
    highlightedMessageTimerRef.current = setTimeout(() => {
      setHighlightedMessageId(null);
      highlightedMessageTimerRef.current = null;
    }, MESSAGE_JUMP_HIGHLIGHT_MS);
  }, []);

  const queueMessageJump = useCallback((
    channelId: string,
    messageId: string,
    sequence?: number,
  ) => {
    const requestId = messageJumpRequestIdRef.current + 1;
    messageJumpRequestIdRef.current = requestId;
    pendingMessageJumpRef.current = {
      channelId,
      messageId,
      requestId,
      ...(typeof sequence === "number" && Number.isFinite(sequence) && sequence > 0
        ? { sequence }
        : {}),
    };
    messageJumpSeekInFlightRef.current = 0;
    messageJumpSeekAttemptedRef.current = 0;
    bumpMessageJumpRevision();
    setBrowserHash(`#message:${messageId}`);
  }, [bumpMessageJumpRevision, setBrowserHash]);

  /* The one landing for every jump consumer — reply previews, search hits,
     follow-up evidence and cold `#message:` deep links. Index addressed first:
     the timeline is virtualized, so a loaded row that is merely off-window has
     no element for `getElementById` to find.

     The DOM anchor behind it covers exactly one case: the virtual list has not
     mounted yet. Nothing else renders a `message:` anchor - rows outside the
     list, a thread root included, carry no id at all - so this cannot answer
     for a message that is simply not loaded.

     Either way the row still has to be seen. `scrollIntoView` returning is not
     a landing, so the anchor path verifies through the same element it just
     scrolled and reports `settling` when the row has not arrived, which hands
     the jump back to the retry and paging paths instead of consuming it. */
  const landMessageJump = useCallback((hash: string, messageId?: string): TimelineJumpOutcome => {
    const outcome = messageId ? timelineJumpRef.current?.scrollToMessage(messageId) : undefined;
    if (outcome && outcome !== "unavailable") return outcome;
    const container = timelineScrollRef.current;
    const element = resolveTimelineAnchor(hash, container);
    if (!element) return "unavailable";
    element.scrollIntoView({ block: "center" });
    return timelineRowIsOnScreen(element, container) ? "landed" : "settling";
  }, [timelineScrollRef]);

  /* The virtualizer needs more than one frame to place a row it was just
     handed, and its prepend anchoring runs after us, so a single scroll call is
     undone. Re-run the landing next frame rather than declaring success, and
     give up after a bounded number of frames so a row that can never be placed
     releases the jump instead of suppressing ordinary scrolling forever. The
     intent's requestId is the generation: a newer jump replaces
     `pendingMessageJumpRef`, and this loop sees the mismatch and stops. */
  const settleMessageJump = useCallback((requestId: number) => {
    const settle = messageJumpSettleRef.current;
    if (settle.requestId !== requestId) {
      settle.requestId = requestId;
      settle.frames = 0;
    }
    if (settle.frames >= MESSAGE_JUMP_SETTLE_FRAMES) {
      if (pendingMessageJumpRef.current?.requestId === requestId) {
        pendingMessageJumpRef.current = null;
      }
      clearBrowserHash();
      setBrowserHash("");
      return;
    }
    settle.frames += 1;
    // At most one frame in flight: a re-entrant landing replaces its own retry
    // instead of stacking a second loop on the same intent.
    if (settle.frame !== null) window.cancelAnimationFrame(settle.frame);
    settle.frame = window.requestAnimationFrame(() => {
      settle.frame = null;
      if (pendingMessageJumpRef.current?.requestId !== requestId) return;
      bumpMessageJumpRevision();
    });
  }, [bumpMessageJumpRevision, setBrowserHash]);

  return {
    pendingMessageJumpRef,
    messageJumpSeekInFlightRef,
    messageJumpSeekAttemptedRef,
    messageJumpRevision,
    bumpMessageJumpRevision,
    highlightedMessageId,
    armMessageJumpHighlight,
    queueMessageJump,
    timelineJumpRef,
    landMessageJump,
    settleMessageJump,
  };
}
