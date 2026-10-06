"use client";

import { useEffect, useRef } from "react";

/** Lets a live push or the socket focus page land before reading over HTTP. */
export const HEAD_CATCH_UP_DELAY_MS = 300;
export const HEAD_CATCH_UP_MAX_RETRY_MS = 30_000;

type Input = {
  channelId: string | null;
  /** The catalog's newest sequence: what the channel list already previews. */
  knownHead: number | undefined;
  /** Newest sequence on screen for this channel; 0 while nothing is painted. */
  presentedHead: number;
  /** Reads rows after `afterSequence` into the open timeline; true when it succeeded. */
  catchUp(channelId: string, afterSequence: number): Promise<{ ok: boolean; found: number }>;
  /** Rows the socket should have pushed arrived over HTTP: check the socket now. */
  onSocketMissedRows(): void;
};

/**
 * The open conversation never lags the channel list. When the catalog head is
 * past the newest row on screen, the socket failed to deliver something (an
 * iOS WebView resumes with a socket that is still OPEN but dead, and nothing
 * notices until the next heartbeat minutes later), so read the gap over HTTP
 * instead of waiting for the socket to recover.
 */
export function useSelectedChannelHeadCatchUp(input: Input): void {
  const inputRef = useRef(input);
  inputRef.current = input;
  // Per channel, the catalog head a completed read already covered. The head can
  // count rows the timeline never shows (deleted), so reaching it is not
  // required; only a newer head starts another read.
  const coveredHeadRef = useRef(new Map<string, number>());
  const { channelId, knownHead, presentedHead } = input;

  useEffect(() => {
    if (!channelId || knownHead === undefined || presentedHead <= 0) return;
    if (knownHead <= presentedHead) return;
    if ((coveredHeadRef.current.get(channelId) ?? 0) >= knownHead) return;
    let cancelled = false;
    let timer: number | undefined;
    let retryMs = 2_000;
    const run = async () => {
      if (cancelled) return;
      const result = await inputRef.current.catchUp(channelId, presentedHead)
        .catch(() => ({ ok: false, found: 0 }));
      if (cancelled) return;
      if (result.ok) {
        coveredHeadRef.current.set(channelId, knownHead);
        if (result.found > 0) inputRef.current.onSocketMissedRows();
        return;
      }
      timer = window.setTimeout(() => void run(), retryMs);
      retryMs = Math.min(retryMs * 2, HEAD_CATCH_UP_MAX_RETRY_MS);
    };
    timer = window.setTimeout(() => void run(), HEAD_CATCH_UP_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [channelId, knownHead, presentedHead]);
}
