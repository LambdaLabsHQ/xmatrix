"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WEB_PROXY_ROUTES, parseDraftSummonIntents, type DraftSummonIntent } from "@xmatrix/protocol";
import { xmatrixRawResponse } from "@/lib/query/api-client";
import { draftSummonRanges } from "./summon-intent";

const READ_AFTER_MS = 350;
const MAX_READ = 4;
const DEADLINE_MS = 6_000;
type Reading = { key: string; readings: DraftSummonIntent[] };
type Request = { key: string; controller: AbortController; promise: Promise<DraftSummonIntent[]> };

/** Preview only the exact current Channel, body and selections. Sending can
 * finish the same bounded request immediately rather than wait for debounce.
 * The Human confirms this reading on send; all launch authorization stays at
 * the ordinary message/registration authority. Older clients still read on send. */
export function useDraftSummonIntents(input: {
  token: string | null; channelId: string | undefined; body: string;
  selections?: ReadonlyArray<{ start: number; end: number; text: string }>;
}): { readings: DraftSummonIntent[]; fresh: boolean; reading: boolean; unavailable: boolean;
  readBeforeSend: () => Promise<DraftSummonIntent[]> } {
  const { token, channelId, body, selections } = input;
  const ranges = useMemo(() => draftSummonRanges(body, selections).slice(0, MAX_READ), [body, selections]);
  const key = JSON.stringify([token, channelId, body, ranges]);
  const [last, setLast] = useState<Reading | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const request = useRef<Request | null>(null);
  const readBeforeSend = useCallback(async () => {
    if (!token || !channelId || !ranges.length) return [];
    if (last?.key === key) return last.readings;
    if (request.current?.key === key) return request.current.promise;
    request.current?.controller.abort();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    setPending(key);
    const promise = (async () => {
      try {
        const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.channel_summon_intent(channelId), {
          method: "POST", cache: "no-store", signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ body, summons: ranges }),
        });
        if (!response.ok) throw new Error("Preview unavailable");
        const payload = await response.json() as { readings?: unknown };
        const readings = parseDraftSummonIntents(payload.readings, body);
        if (!readings || readings.length !== ranges.length || readings.some((item, index) =>
          item.start !== ranges[index]?.start || item.end !== ranges[index]?.end)) throw new Error("Invalid preview");
        if (controller.signal.aborted) return [];
        setLast({ key, readings });
        setFailed(null);
        return readings;
      } catch {
        if (!controller.signal.aborted || request.current?.key === key) setFailed(key);
        return [];
      } finally {
        clearTimeout(timer);
        setPending(current => current === key ? null : current);
      }
    })();
    request.current = { key, controller, promise };
    return promise;
  }, [token, channelId, body, ranges, key, last]);
  // The reading function changes after a result; the draft key owns cancellation.
  const readRef = useRef(readBeforeSend);
  readRef.current = readBeforeSend;
  useEffect(() => {
    if (!token || !channelId || !ranges.length) return;
    setPending(key);
    const timer = setTimeout(() => { void readRef.current(); }, READ_AFTER_MS);
    return () => {
      clearTimeout(timer);
      if (request.current?.key === key) { request.current.controller.abort(); request.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const enabled = !!token && !!channelId && ranges.length > 0;
  const fresh = enabled && last?.key === key;
  return { readings: fresh ? last.readings : [], fresh, reading: enabled && pending === key,
    unavailable: enabled && failed === key, readBeforeSend };
}
