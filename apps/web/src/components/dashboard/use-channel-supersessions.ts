"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SUPERSEDED_ANNOTATION_NAMESPACE,
  SYSTEM_ANNOTATION_AUTHOR,
  WEB_PROXY_ROUTES,
} from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { timelineItemActivity } from "./conversation-activity-rows";
import type { TimelineItem } from "./workspace-shell-message-model";

/**
 * Supersession judgments made after their messages reached this client
 * (docs/design/conversation-activity.md §3.3). A history read already carries
 * `supersededBy`; a message that arrived live is judged moments after the
 * next one from its sender, within Jev's five-second budget. So each new
 * message is followed by a few reads of recent judgments, and then nothing
 * until the next message. The reads belong to the Channel, not to the
 * message: in a busy conversation the messages share them, one read per
 * interval, instead of each one starting its own.
 */
const LOOKS_PER_MESSAGE = 3;
const LOOK_INTERVAL_MS = 5_000;
/** Judgments older than this are already on the history a client read. */
const RECENT_WINDOW_MS = 15 * 60 * 1000;
const EMPTY: ReadonlyMap<string, string> = new Map();

export function parseSupersessions(payload: unknown): [messageId: string, supersededBy: string][] {
  const annotations = payload && typeof payload === "object"
    ? (payload as { annotations?: unknown }).annotations
    : undefined;
  if (!Array.isArray(annotations)) return [];
  const judgments: [string, string][] = [];
  for (const value of annotations) {
    if (!value || typeof value !== "object") continue;
    const annotation = value as Record<string, unknown>;
    // Only the Hub's own judgment counts; public writers cannot author it.
    if (annotation.namespace !== SUPERSEDED_ANNOTATION_NAMESPACE ||
        annotation.authorUserId !== SYSTEM_ANNOTATION_AUTHOR) continue;
    const target = annotation.target as { messageId?: unknown } | undefined;
    const payloadValue = annotation.payload as { supersededBy?: unknown } | undefined;
    if (typeof target?.messageId === "string" && typeof payloadValue?.supersededBy === "string") {
      judgments.push([target.messageId, payloadValue.supersededBy]);
    }
  }
  return judgments;
}

export function useChannelSupersessions(
  channelId: string | undefined,
  token: string | null,
  timeline: readonly TimelineItem[],
): ReadonlyMap<string, string> {
  const { user } = useAuth();
  const tail = timeline[timeline.length - 1];
  // Only a message someone said can supersede the one before it.
  const tailMessageId = tail?.messageId && !timelineItemActivity(tail) ? tail.messageId : undefined;
  // Until when the last message still has reads to come.
  const lookUntilRef = useRef(0);
  const query = useQuery<[messageId: string, supersededBy: string][]>({
    queryKey: xmatrixQueryKeys.domain({ userId: user?.id ?? "anonymous" }, "channel-supersessions",
      [channelId ?? ""]),
    enabled: Boolean(channelId && token && tailMessageId && user?.id),
    retry: false,
    staleTime: Infinity,
    refetchInterval: () => Date.now() < lookUntilRef.current ? LOOK_INTERVAL_MS : false,
    queryFn: async ({ signal }) => {
      const search = new URLSearchParams({
        namespace: SUPERSEDED_ANNOTATION_NAMESPACE,
        afterCreatedAt: new Date(Date.now() - RECENT_WINDOW_MS).toISOString(),
      });
      const payload = await xmatrixApiRequest<unknown>({
        url: `${WEB_PROXY_ROUTES.channel_annotations(channelId!)}?${search}`,
        token: token!,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      return parseSupersessions(payload);
    },
  });
  const look = query.refetch;
  const looking = Boolean(channelId && token && user?.id);
  useEffect(() => {
    if (!looking || !tailMessageId) return;
    const resting = Date.now() >= lookUntilRef.current;
    // The read at arrival and one per interval after it: the last falls inside this.
    lookUntilRef.current = Date.now() + (LOOKS_PER_MESSAGE - 1.5) * LOOK_INTERVAL_MS;
    // Reads already under way reach this message too; otherwise it starts them.
    if (resting) void look({ cancelRefetch: false });
  }, [look, looking, tailMessageId]);
  const [judged, setJudged] = useState<{ channelId?: string; judgments: ReadonlyMap<string, string> }>(
    { judgments: EMPTY },
  );
  useEffect(() => {
    const judgments = query.data;
    if (!channelId || !judgments || judgments.length === 0) return;
    setJudged((current) => {
      const base = current.channelId === channelId ? current.judgments : EMPTY;
      if (judgments.every(([messageId, by]) => base.get(messageId) === by)) {
        return current.channelId === channelId ? current : { channelId, judgments: base };
      }
      const next = new Map(base);
      for (const [messageId, by] of judgments) next.set(messageId, by);
      return { channelId, judgments: next };
    });
  }, [channelId, query.data]);
  return judged.channelId === channelId ? judged.judgments : EMPTY;
}
